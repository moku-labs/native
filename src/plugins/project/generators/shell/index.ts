/**
 * @file project plugin generator — the `tauri-plugin-moku-shell` crate tree under
 * `plugins/moku-shell/`. Orchestration only: each file comes from its sibling module.
 */
import type { BuildProfile } from "../../../../config";
import type { Artifact, GeneratorInput } from "../types";

/**
 * Generates every file of the shell plugin crate, or nothing when `shell` is not resolved.
 *
 * @param _input - The generator input for this target.
 * @param _profile - The build profile the crate is generated for.
 * @example
 * ```ts
 * generateShell(input, "debug"); // plugins/moku-shell/** artifacts
 * ```
 */
export function generateShell(_input: GeneratorInput, _profile: BuildProfile): Artifact[] {
  throw new Error("not implemented");
}
