/**
 * @file project plugin generator — the shell crate's Android library module: Gradle
 * build, manifest, `MokuShellPlugin.kt` and the per-profile `MokuShellProfile.kt`.
 */
import type { BuildProfile } from "../../../../config";
import type { Artifact } from "../types";

/**
 * Generates the shell crate's Android module files.
 *
 * @param _profile - The build profile `MokuShellProfile.DEBUG` follows.
 * @example
 * ```ts
 * shellAndroidArtifacts("debug"); // MokuShellProfile.DEBUG = true
 * ```
 */
export function shellAndroidArtifacts(_profile: BuildProfile): Artifact[] {
  throw new Error("not implemented");
}
