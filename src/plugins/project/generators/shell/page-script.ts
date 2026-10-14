/**
 * @file project plugin generator — the shell crate's `src/page.js`: the page contract
 * `globalThis.__MOKU_NATIVE__` v1, installed before page scripts.
 */
import type { BuildProfile } from "../../../../config";
import type { GeneratorInput } from "../types";

/**
 * Builds the page contract script for one app and profile.
 *
 * @param _input - The generator input (app version and build number feed the build id).
 * @param _profile - The build profile baked into the script.
 * @example
 * ```ts
 * shellPageScript(input, "store"); // the src/page.js text
 * ```
 */
export function shellPageScript(_input: GeneratorInput, _profile: BuildProfile): string {
  throw new Error("not implemented");
}
