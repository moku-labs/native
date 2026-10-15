/**
 * @file project plugin — the shell linkage check: `gen/android/tauri.settings.gradle` must
 * name `moku-shell`, or every `__MOKU_NATIVE__` call fails at runtime with no build error.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BuildProfile, Config, MobileTarget } from "../../../config";
import { genDirectoryPath } from "../layout";
import { resolveConfiguredCapabilities } from "../registry";

/**
 * The Gradle settings file the Tauri CLI writes from every plugin's Android library path.
 * Whether `tauri android build` regenerates it or only `tauri android init` does is
 * UNVERIFIED (research Q1) — which is exactly why it is checked after the compile.
 */
const TAURI_SETTINGS = "tauri.settings.gradle";

/**
 * Fails with a `[native]` error when the shell plugin is not linked into `gen/android`:
 * the settings file is missing, or does not name `moku-shell`.
 *
 * @param options - Where to look.
 * @param options.genDirectory - Absolute `src-tauri/gen/android` path.
 * @throws {Error} `[native] the shell plugin is not linked into gen/android …`.
 * @example
 * ```ts
 * await assertShellLinked({ genDirectory: "/repo/.moku/tauri/src-tauri/gen/android" });
 * // rejects: [native] the shell plugin is not linked into gen/android … when tauri.settings.gradle has no moku-shell
 * ```
 */
export async function assertShellLinked(options: { genDirectory: string }): Promise<void> {
  const settingsPath = path.join(options.genDirectory, TAURI_SETTINGS);
  const settings = existsSync(settingsPath) ? await readFile(settingsPath, "utf8") : "";
  if (settings.includes("moku-shell")) return;

  throw new Error(
    "[native] the shell plugin is not linked into gen/android (tree initialised before the shell was added).\n  Run clean for android and build again."
  );
}

/**
 * Runs {@link assertShellLinked} when the shell is composed for this target and profile —
 * named in `config.system`, or implied by the debug profile on android — and does nothing
 * otherwise.
 *
 * @param options - The check options.
 * @param options.global - Frozen global config (`system`, `projectDir`).
 * @param options.target - The mobile platform that was compiled.
 * @param options.profile - The build profile.
 * @returns Resolves once the check passed or did not apply.
 * @throws {Error} When the shell is composed but not linked.
 */
export async function checkShellLinked(options: {
  global: Readonly<Config>;
  target: MobileTarget;
  profile: BuildProfile;
}): Promise<void> {
  const composed = resolveConfiguredCapabilities(
    options.global,
    options.target,
    options.profile
  ).some(capability => capability.name === "shell");
  if (!composed) return;

  await assertShellLinked({
    genDirectory: genDirectoryPath(options.global.projectDir, options.target)
  });
}
