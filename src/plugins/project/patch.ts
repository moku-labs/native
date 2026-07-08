/**
 * @file project plugin — Android signing state patch (the ONLY v1 mobile patch domain).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SigningConfig } from "../../config";
import type { PatchResult } from "./types";
import { writeIfChanged } from "./writer";

const SIGNING_START = "// MOKU-SIGNING-START";
const SIGNING_END = "// MOKU-SIGNING-END";

/**
 * Renders the `keystore.properties` content Gradle reads for release signing. Values
 * are env-var REFERENCES and config-safe identifiers only — never raw secrets, per the
 * `SigningConfig` invariant.
 *
 * @param signing - The Android signing config slice (empty object when unconfigured).
 * @returns The `keystore.properties` file content.
 * @example
 * ```ts
 * renderKeystoreProperties({ keystorePath: "keystore.jks", keystorePasswordEnv: "KS_PASSWORD", keyAlias: "release" });
 * ```
 */
export function renderKeystoreProperties(signing: NonNullable<SigningConfig["android"]>): string {
  return [
    `storeFile=${signing.keystorePath ?? ""}`,
    `storePasswordEnvVar=${signing.keystorePasswordEnv ?? ""}`,
    `keyAlias=${signing.keyAlias ?? ""}`,
    `keyPasswordEnvVar=${signing.keystorePasswordEnv ?? ""}`,
    ""
  ].join("\n");
}

/**
 * Idempotently inserts or replaces the moku-managed signing block inside an existing
 * `app/build.gradle.kts`. Re-applying to already-patched content is a text-level no-op:
 * `applySigningBlock(applySigningBlock(x, s), s) === applySigningBlock(x, s)`.
 *
 * @param existing - The current `build.gradle.kts` content.
 * @param signing - The Android signing config slice (empty object when unconfigured).
 * @returns The patched content with exactly one signing block, sentinel-delimited.
 * @example
 * ```ts
 * applySigningBlock(gradleKts, { keyAlias: "release" });
 * ```
 */
export function applySigningBlock(
  existing: string,
  signing: NonNullable<SigningConfig["android"]>
): string {
  const block = [
    SIGNING_START,
    "android {",
    "  signingConfigs {",
    '    create("release") {',
    `      storeFile = file(project.property("MOKU_KEYSTORE_PATH") as? String ?: "${signing.keystorePath ?? ""}")`,
    `      keyAlias = "${signing.keyAlias ?? ""}"`,
    "    }",
    "  }",
    "}",
    SIGNING_END
  ].join("\n");

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
 * Deterministic, idempotent post-init patch pass over an existing complete gen/ tree.
 * v1 scope (spike a): Android signing state only (`keystore.properties` +
 * `build.gradle.kts` signing block). iOS has zero mobile-permission plist mechanism to
 * patch in v1 (D-012) — it is a documented no-op, kept in the signature for pipeline
 * uniformity.
 *
 * @param projectDirectory - The Tauri project root.
 * @param target - The mobile platform to patch.
 * @param signing - The full signing config (only `.android` is consulted).
 * @returns The paths patched vs. left unchanged.
 * @throws {Error} When the Android `gen/android` tree (or its `app/build.gradle.kts`) is missing.
 * @example
 * ```ts
 * await patchMobile("/repo/.moku/tauri", "android", { android: { keyAlias: "release" } });
 * ```
 */
export async function patchMobile(
  projectDirectory: string,
  target: "ios" | "android",
  signing: SigningConfig
): Promise<PatchResult> {
  if (target === "ios") {
    return { patched: [], unchanged: [] };
  }

  const genDirectory = path.join(projectDirectory, "src-tauri", "gen", "android");
  const buildGradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  if (!existsSync(genDirectory) || !existsSync(buildGradlePath)) {
    throw new Error(
      `[native] Android gen/ tree not found or incomplete at ${genDirectory}.\n  Run the mobile init pass (tauri android init) before patching signing state.`
    );
  }

  const android = signing.android ?? {};
  const patched: string[] = [];
  const unchanged: string[] = [];

  const keystorePropertiesPath = path.join(genDirectory, "keystore.properties");
  const keystoreAction = await writeIfChanged(
    keystorePropertiesPath,
    renderKeystoreProperties(android)
  );
  (keystoreAction === "written" ? patched : unchanged).push(keystorePropertiesPath);

  const existingGradle = await readFile(buildGradlePath, "utf8");
  const patchedGradle = applySigningBlock(existingGradle, android);
  const gradleAction = await writeIfChanged(buildGradlePath, patchedGradle);
  (gradleAction === "written" ? patched : unchanged).push(buildGradlePath);

  return { patched, unchanged };
}
