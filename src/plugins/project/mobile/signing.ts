/**
 * @file project plugin — the Android release-signing block the mobile patch pass keeps in
 * `gen/android/app/build.gradle.kts`. Only env-var NAMES are ever written to disk: Gradle
 * reads the passwords itself, at build time. The debug profile is the one exception: it
 * signs with the SDK's well-known debug keystore, whose password is public (`android`).
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { EnvApi } from "@moku-labs/common";
import type { SigningConfig } from "../../../config";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";

const SIGNING_START = "// MOKU-SIGNING-START";
const SIGNING_END = "// MOKU-SIGNING-END";

/**
 * The Android SDK's debug key: its alias, and the `-storepass`/`-keypass` value every SDK
 * debug keystore is created with. Both are public SDK defaults, not secrets.
 */
const DEBUG_KEY_ALIAS = "androiddebugkey";
const DEBUG_KEY_STOREPASS = "android";

/** The fields of one rendered signing block — every value goes through {@link kotlinString}. */
type SigningBlock = {
  readonly keystorePath: string;
  readonly keyAlias: string;
  /** Kotlin expression for the store password: an env-var read, or a literal. */
  readonly storePassword: string;
  /** Kotlin expression for the key password. */
  readonly keyPassword: string;
};

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
 * Describes the store signing block of a configured keystore. Passwords are read by Gradle
 * itself from the environment at build time — only env-var NAMES are ever written to disk,
 * per the `SigningConfig` invariant. `keyPasswordEnv` falls back to `keystorePasswordEnv`,
 * which is the common single-password keystore.
 *
 * @param signing - The Android signing config slice, with a keystore path already present.
 * @param keystorePath - The configured keystore path.
 * @returns The block's fields.
 * @example
 * ```ts
 * storeSigning({ keyAlias: "release", keystorePasswordEnv: "KS" }, "release.jks").storePassword;
 * // 'System.getenv("KS")'
 * ```
 */
function storeSigning(
  signing: NonNullable<SigningConfig["android"]>,
  keystorePath: string
): SigningBlock {
  const storePasswordEnvironment = signing.keystorePasswordEnv ?? "";
  const keyPasswordEnvironment = signing.keyPasswordEnv ?? storePasswordEnvironment;
  return {
    keystorePath,
    keyAlias: signing.keyAlias ?? "",
    storePassword: `System.getenv("${kotlinString(storePasswordEnvironment)}")`,
    keyPassword: `System.getenv("${kotlinString(keyPasswordEnvironment)}")`
  };
}

/**
 * Describes the debug signing block: the SDK debug keystore, its public alias and password.
 *
 * @param keystorePath - The debug keystore path from {@link debugKeystorePath}.
 * @returns The block's fields.
 * @example
 * ```ts
 * debugSigning("/home/me/.android/debug.keystore").keyAlias; // "androiddebugkey"
 * ```
 */
function debugSigning(keystorePath: string): SigningBlock {
  const password = `"${DEBUG_KEY_STOREPASS}"`;
  return {
    keystorePath,
    keyAlias: DEBUG_KEY_ALIAS,
    storePassword: password,
    keyPassword: password
  };
}

/**
 * Renders the moku-managed Gradle signing block. Every interpolated path and alias goes
 * through {@link kotlinString}, so a path or alias can never close the literal it sits in.
 *
 * @param block - The block's fields.
 * @returns The sentinel-delimited Gradle block.
 * @example
 * ```ts
 * renderSigningBlock(debugSigning("/home/me/.android/debug.keystore"));
 * ```
 */
function renderSigningBlock(block: SigningBlock): string {
  return [
    SIGNING_START,
    "android {",
    "  signingConfigs {",
    '    maybeCreate("release").apply {',
    `      storeFile = file("${kotlinString(block.keystorePath)}")`,
    `      keyAlias = "${kotlinString(block.keyAlias)}"`,
    `      storePassword = ${block.storePassword}`,
    `      keyPassword = ${block.keyPassword}`,
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
  return writeSigningBlock(
    existing,
    renderSigningBlock(storeSigning(signing, signing.keystorePath))
  );
}

/**
 * Inserts the rendered block, or replaces the one already there in place.
 *
 * @param existing - The current `build.gradle.kts` content.
 * @param block - The rendered block.
 * @returns The content with exactly that one block.
 * @example
 * ```ts
 * writeSigningBlock("plugins {}\n", block); // "plugins {}\n\n<block>\n"
 * ```
 */
function writeSigningBlock(existing: string, block: string): string {
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
 * Resolves the SDK debug keystore, `<home>/.android/debug.keystore`, where `home` is `HOME`,
 * or `USERPROFILE` on a Windows host that has no `HOME`. Read through `ctx.env`, never
 * `process.env`.
 *
 * @param env - The env core API (only `get` is read).
 * @returns The debug keystore path.
 * @throws {Error} `[native]` when neither variable is set.
 * @example
 * ```ts
 * debugKeystorePath({ get: key => (key === "USERPROFILE" ? "C:\\Users\\me" : undefined) });
 * // "C:\\Users\\me\\.android\\debug.keystore" on Windows
 * ```
 */
export function debugKeystorePath(env: Pick<EnvApi, "get">): string {
  const home = env.get("HOME") || env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "[native] the debug profile signs with the debug keystore in your home directory, but neither HOME nor USERPROFILE is set.\n  Set HOME to your home directory and build again."
    );
  }
  return path.join(home, ".android", "debug.keystore");
}

/**
 * Fails early, with the command that creates it, when the debug keystore is missing —
 * instead of deep inside Gradle's `validateSigningRelease`.
 *
 * @param keystorePath - The debug keystore path from {@link debugKeystorePath}.
 * @throws {Error} `[native] debug keystore not found at <path>.` with the `keytool` fix.
 * @example
 * ```ts
 * assertDebugKeystore("/home/me/.android/debug.keystore"); // throws when the file is absent
 * ```
 */
export function assertDebugKeystore(keystorePath: string): void {
  if (existsSync(keystorePath)) return;

  throw new Error(
    `[native] debug keystore not found at ${keystorePath}.\n  Create it with: keytool -genkeypair -v -keystore "${keystorePath}" -storepass ${DEBUG_KEY_STOREPASS} -alias ${DEBUG_KEY_ALIAS} -keypass ${DEBUG_KEY_STOREPASS} -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US".`
  );
}

/**
 * Patches Android release signing into `app/build.gradle.kts`, and clears the legacy
 * `keystore.properties` a previous version of this plugin wrote. Signing now lives in
 * Gradle only, so nothing ever re-creates that file. With a `debugKeystore` (the debug
 * profile) the release build is signed with the SDK debug key instead, and the store
 * keystore is never named; the next store pass writes the store block back in place.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param signing - The Android signing config slice (empty object when unconfigured).
 * @param debugKeystore - The debug keystore path, in the debug profile only.
 * @returns The paths patched vs. left unchanged.
 * @example
 * ```ts
 * await patchAndroidSigning(projectDir, genDir, { keystorePath: "release.jks" });
 * ```
 */
export async function patchAndroidSigning(
  projectDirectory: string,
  genDirectory: string,
  signing: NonNullable<SigningConfig["android"]>,
  debugKeystore?: string
): Promise<PatchResult> {
  const patched: string[] = [];
  const unchanged: string[] = [];

  const buildGradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  const existingGradle = await readFile(buildGradlePath, "utf8");
  const next =
    debugKeystore === undefined
      ? applySigningBlock(existingGradle, signing)
      : writeSigningBlock(existingGradle, renderSigningBlock(debugSigning(debugKeystore)));
  const action = await writeIfChanged(buildGradlePath, next, projectDirectory);
  (action === "written" ? patched : unchanged).push(buildGradlePath);

  // Single named file inside gen/android, never a recursive remove.
  const keystorePropertiesPath = path.join(genDirectory, "keystore.properties");
  if (!signing.keystorePath && existsSync(keystorePropertiesPath)) {
    await rm(keystorePropertiesPath, { force: true });
    patched.push(keystorePropertiesPath);
  }

  return { patched, unchanged };
}
