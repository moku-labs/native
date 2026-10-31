/**
 * @file project plugin generator — the `tauri-plugin-moku-shell` crate tree under
 * `plugins/moku-shell/`. Orchestration only: each file comes from its sibling module.
 */
import type { BuildProfile } from "../../../../config";
import type { Artifact, GeneratorInput } from "../types";
import { shellAndroidArtifacts } from "./android";
import { shellPageScript } from "./page-script";
import { shellRustArtifacts } from "./rust";

/**
 * Generates every file of the shell plugin crate, under the `shell` row's `localCrate`
 * directory, or nothing when `shell` is not resolved for this target — so an app without
 * the shell gets no `plugins/` directory at all.
 *
 * @param input - The generator input for this target, capabilities already resolved.
 * @param profile - The build profile the crate is generated for.
 * @returns The crate's artifacts, paths relative to `projectDir`; empty without the shell.
 * @example
 * ```ts
 * generateShell({ global, target: "android", capabilities: [resolve("shell")], profile: "debug" }, "debug")[0]?.path;
 * // "plugins/moku-shell/Cargo.toml"
 * ```
 */
export function generateShell(input: GeneratorInput, profile: BuildProfile): Artifact[] {
  const directory = input.capabilities.find(capability => capability.name === "shell")?.localCrate
    ?.directory;
  if (directory === undefined) return [];

  const crate: Artifact[] = [
    ...shellRustArtifacts(),
    { path: "src/page.js", content: shellPageScript(input, profile) },
    ...shellAndroidArtifacts(profile)
  ];
  return crate.map(artifact => ({
    path: `${directory}/${artifact.path}`,
    content: artifact.content
  }));
}
