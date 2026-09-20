/**
 * @file project plugin — the Android release-signing block the mobile patch pass keeps in
 * `gen/android/app/build.gradle.kts`. Only env-var NAMES are ever written to disk: Gradle
 * reads the passwords itself, at build time.
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { SigningConfig } from "../../../config";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";

const SIGNING_START = "// MOKU-SIGNING-START";
const SIGNING_END = "// MOKU-SIGNING-END";

/**
 * Characters that change the meaning of a Kotlin string literal: a backslash starts an
 * escape, a double quote closes the literal, a dollar sign starts a template expression,
 * and a raw newline ends the line outright.
 */
const KOTLIN_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\\/g, String.raw`\\`],
  [/"/g, String.raw`\"`],
  [/\$/g, String.raw`\$`],
  [/\r/g, String.raw`\r`],
  [/\n/g, String.raw`\n`]
];

/**
 * Escapes a value for use inside a double-quoted Kotlin string literal. Config values land
 * verbatim in `build.gradle.kts` — an unescaped `"` would close the literal and an
 * unescaped `$` would interpolate a Gradle expression, so every one of them is escaped
 * here rather than trusted.
 *
 * @param value - The raw config value (keystore path, key alias, env-var name).
 * @returns The value, safe to place between double quotes in Kotlin source.
 * @example
 * ```ts
 * kotlinString('re"lease$HOME'); // 're\\"lease\\$HOME'
 * ```
 */
export function kotlinString(value: string): string {
  let escaped = value;
  for (const [pattern, replacement] of KOTLIN_ESCAPES) {
    escaped = escaped.replace(pattern, replacement);
  }
  return escaped;
}

/**
 * Renders the moku-managed Gradle signing block. Passwords are read by Gradle itself from
 * the environment at build time — only env-var NAMES are ever written to disk, per the
 * `SigningConfig` invariant. `keyPasswordEnv` falls back to `keystorePasswordEnv`, which
 * is the common single-password keystore. Every interpolated value goes through
 * {@link kotlinString}, so a path or alias can never close the literal it sits in.
 *
 * @param signing - The Android signing config slice, with a keystore path already present.
 * @param keystorePath - The configured keystore path.
 * @returns The sentinel-delimited Gradle block.
 * @example
 * ```ts
 * renderSigningBlock({ keyAlias: "release" }, "release.jks");
 * ```
 */
function renderSigningBlock(
  signing: NonNullable<SigningConfig["android"]>,
  keystorePath: string
): string {
  const storePasswordEnvironment = signing.keystorePasswordEnv ?? "";
  const keyPasswordEnvironment = signing.keyPasswordEnv ?? storePasswordEnvironment;

  return [
    SIGNING_START,
    "android {",
    "  signingConfigs {",
    '    maybeCreate("release").apply {',
    `      storeFile = file("${kotlinString(keystorePath)}")`,
    `      keyAlias = "${kotlinString(signing.keyAlias ?? "")}"`,
    `      storePassword = System.getenv("${kotlinString(storePasswordEnvironment)}")`,
    `      keyPassword = System.getenv("${kotlinString(keyPasswordEnvironment)}")`,
    "    }",
    "  }",
    "  buildTypes {",
    '    getByName("release") {',
    '      signingConfig = signingConfigs.getByName("release")',
    "    }",
    "  }",
    "}",
    SIGNING_END
  ].join("\n");
}

/**
 * Strips the moku-managed signing block (and the blank line it was inserted with) from
 * Gradle content, leaving content that never carried one untouched.
 *
 * @param existing - The current `build.gradle.kts` content.
 * @returns The content without a moku signing block.
 * @example
 * ```ts
 * removeSigningBlock(patchedGradleKts);
 * ```
 */
export function removeSigningBlock(existing: string): string {
  const startIndex = existing.indexOf(SIGNING_START);
  const endIndex = existing.indexOf(SIGNING_END);
  if (startIndex === -1 || endIndex === -1) return existing;

  let before = existing.slice(0, startIndex);
  while (before.endsWith("\n")) before = before.slice(0, -1);

  let after = existing.slice(endIndex + SIGNING_END.length);
  while (after.startsWith("\n")) after = after.slice(1);

  return before.length > 0 ? `${before}\n${after}` : after;
}

/**
 * Idempotently inserts, replaces or removes the moku-managed signing block inside an
 * existing `app/build.gradle.kts`. Re-applying to already-patched content is a text-level
 * no-op; an unconfigured keystore REMOVES a block a previous build left behind, so
 * dropping `signing.android.keystorePath` really does return to unsigned builds.
 *
 * @param existing - The current `build.gradle.kts` content.
 * @param signing - The Android signing config slice (empty object when unconfigured).
 * @returns The patched content with exactly one signing block, or none when unconfigured.
 * @example
 * ```ts
 * applySigningBlock(gradleKts, { keystorePath: "release.jks", keyAlias: "release" });
 * ```
 */
export function applySigningBlock(
  existing: string,
  signing: NonNullable<SigningConfig["android"]>
): string {
  if (!signing.keystorePath) return removeSigningBlock(existing);

  const block = renderSigningBlock(signing, signing.keystorePath);
  const startIndex = existing.indexOf(SIGNING_START);
  const endIndex = existing.indexOf(SIGNING_END);
  if (startIndex === -1 || endIndex === -1) {
    const separator = existing.endsWith("\n") ? "" : "\n";
    return `${existing}${separator}\n${block}\n`;
  }

  const before = existing.slice(0, startIndex);
  const after = existing.slice(endIndex + SIGNING_END.length);
  return `${before}${block}${after}`;
}

/**
 * Patches Android release signing into `app/build.gradle.kts`, and clears the legacy
 * `keystore.properties` a previous version of this plugin wrote. Signing now lives in
 * Gradle only, so nothing ever re-creates that file.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param signing - The Android signing config slice (empty object when unconfigured).
 * @returns The paths patched vs. left unchanged.
 * @example
 * ```ts
 * await patchAndroidSigning(projectDir, genDir, { keystorePath: "release.jks" });
 * ```
 */
export async function patchAndroidSigning(
  projectDirectory: string,
  genDirectory: string,
  signing: NonNullable<SigningConfig["android"]>
): Promise<PatchResult> {
  const patched: string[] = [];
  const unchanged: string[] = [];

  const buildGradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  const existingGradle = await readFile(buildGradlePath, "utf8");
  const action = await writeIfChanged(
    buildGradlePath,
    applySigningBlock(existingGradle, signing),
    projectDirectory
  );
  (action === "written" ? patched : unchanged).push(buildGradlePath);

  // Single named file inside gen/android, never a recursive remove.
  const keystorePropertiesPath = path.join(genDirectory, "keystore.properties");
  if (!signing.keystorePath && existsSync(keystorePropertiesPath)) {
    await rm(keystorePropertiesPath, { force: true });
    patched.push(keystorePropertiesPath);
  }

  return { patched, unchanged };
}
