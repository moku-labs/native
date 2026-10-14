/**
 * @file project plugin — the build-profile patches of the Android tree: the Gradle
 * profile block, the debug app name in `strings.xml` and the debug network security config.
 * Each patch is a pure text transform, idempotent, and the store profile restores the bytes.
 */
import type { BuildProfile, Config } from "../../../config";
import type { PatchResult } from "../types";

/**
 * Applies (debug) or reverts (store) the profile patches under `gen/android`.
 *
 * @param _options - What to patch.
 * @param _options.genDirectory - Absolute `src-tauri/gen/android` path.
 * @param _options.global - Frozen global config (app name for the debug label).
 * @param _options.profile - The build profile.
 * @example
 * ```ts
 * await patchAndroidProfile({ genDirectory, global, profile: "debug" });
 * ```
 */
export async function patchAndroidProfile(_options: {
  genDirectory: string;
  global: Readonly<Config>;
  profile: BuildProfile;
}): Promise<PatchResult> {
  throw new Error("not implemented");
}
