/**
 * @file tauri plugin — pure per-verb argv builders (spike (b): D-013 invocation shape).
 *
 * Every builder returns the FULL argv tuple already prefixed with
 * `[nodePath, tauriJsPath, ...]` — callers never assemble the prefix themselves.
 * No `tauri init` verb exists here by design (D-013) — only `ios|android init`.
 */
import type { Target } from "../../config";
import type { BuildArgvOptions } from "./types";

/**
 * Maps a host architecture to the iOS simulator rust target tauri expects:
 * an Intel host builds the `x86_64` simulator slice, everything else `aarch64-sim`.
 *
 * @param arch - Host architecture (`process.arch`-shaped).
 * @returns The `--target` value for a simulator build.
 * @example
 * ```ts
 * simulatorTarget("arm64"); // "aarch64-sim"
 * ```
 */
function simulatorTarget(arch: NodeJS.Architecture): string {
  return arch === "x64" ? "x86_64" : "aarch64-sim";
}

/**
 * Builds the argv for `tauri build` / `tauri ios|android build`.
 *
 * iOS: a `simulator` build pins the host's simulator rust target and never
 * exports (no `--export-method`, which only applies to a device archive);
 * a device build passes `--export-method` when the app configured one.
 * Android defaults to `--apk` (directly installable) and switches to `--aab`
 * (store submission) on request. Desktop targets take no options.
 *
 * @param nodePath - Resolved `node` binary path.
 * @param tauriJsPath - Resolved `@tauri-apps/cli/tauri.js` entry path.
 * @param opts - Build options (target, simulator, exportMethod, aab).
 * @param arch - Host architecture, injectable for tests. Defaults to `process.arch`.
 * @returns The full `[nodePath, tauriJsPath, ...]` argv tuple.
 * @example
 * ```ts
 * buildArgv("/usr/bin/node", "/.../tauri.js", { target: "ios", simulator: true }, "arm64");
 * // [..., "ios", "build", "--ci", "--target", "aarch64-sim"]
 * ```
 */
export function buildArgv(
  nodePath: string,
  tauriJsPath: string,
  opts: BuildArgvOptions,
  arch: NodeJS.Architecture = process.arch
): readonly string[] {
  const prefix = [nodePath, tauriJsPath];

  if (opts.target === "ios") {
    const ios = [...prefix, "ios", "build", "--ci"];
    if (opts.simulator) return [...ios, "--target", simulatorTarget(arch)];
    if (opts.exportMethod) return [...ios, "--export-method", opts.exportMethod];
    return ios;
  }

  if (opts.target === "android") {
    return [...prefix, "android", "build", "--ci", opts.aab ? "--aab" : "--apk"];
  }

  return [...prefix, "build", "--ci"];
}

/**
 * Builds the argv for the long-lived dev verb: `tauri dev` / `tauri ios|android dev`.
 * Mobile dev omits `--ci` (the CLI drives `TAURI_DEV_HOST` itself for device pairing).
 *
 * @param nodePath - Resolved `node` binary path.
 * @param tauriJsPath - Resolved `@tauri-apps/cli/tauri.js` entry path.
 * @param target - Packaging target (desktop targets and `undefined` are target-uniform).
 * @returns The full `[nodePath, tauriJsPath, ...]` argv tuple.
 * @example
 * ```ts
 * devArgv("/usr/bin/node", "/.../tauri.js", "android"); // [..., "android", "dev"]
 * ```
 */
export function devArgv(nodePath: string, tauriJsPath: string, target?: Target): readonly string[] {
  const prefix = [nodePath, tauriJsPath];
  if (target === "ios" || target === "android") return [...prefix, target, "dev"];
  return [...prefix, "dev", "--ci"];
}

/**
 * Builds the argv for `tauri icon` (regenerates the icon set from a source image).
 *
 * `--output` is always explicit: without it the CLI writes relative to its own
 * cwd, which is not the generated project's `src-tauri/icons` (B5/A8).
 *
 * @param nodePath - Resolved `node` binary path.
 * @param tauriJsPath - Resolved `@tauri-apps/cli/tauri.js` entry path.
 * @param source - Path to the source icon image.
 * @param outputDirectory - Absolute `<projectDir>/src-tauri/icons` directory to write the set into.
 * @returns The full `[nodePath, tauriJsPath, ...]` argv tuple.
 * @example
 * ```ts
 * iconArgv("/usr/bin/node", "/.../tauri.js", "icon.png", "/app/.moku/tauri/src-tauri/icons");
 * // [..., "icon", "icon.png", "--output", "/app/.moku/tauri/src-tauri/icons"]
 * ```
 */
export function iconArgv(
  nodePath: string,
  tauriJsPath: string,
  source: string,
  outputDirectory: string
): readonly string[] {
  return [nodePath, tauriJsPath, "icon", source, "--output", outputDirectory];
}

/**
 * Builds the argv for `tauri ios|android init` — the ONLY init verbs (D-013);
 * plain `tauri init` is never used since the desktop tree is project-generated.
 *
 * @param nodePath - Resolved `node` binary path.
 * @param tauriJsPath - Resolved `@tauri-apps/cli/tauri.js` entry path.
 * @param target - Mobile target to initialize.
 * @returns The full `[nodePath, tauriJsPath, ...]` argv tuple.
 * @example
 * ```ts
 * mobileInitArgv("/usr/bin/node", "/.../tauri.js", "ios"); // [..., "ios", "init", "--ci"]
 * ```
 */
export function mobileInitArgv(
  nodePath: string,
  tauriJsPath: string,
  target: "ios" | "android"
): readonly string[] {
  return [nodePath, tauriJsPath, target, "init", "--ci"];
}

/**
 * Builds the argv for `tauri info` — the CLI presence/version probe used by `doctor`.
 *
 * @param nodePath - Resolved `node` binary path.
 * @param tauriJsPath - Resolved `@tauri-apps/cli/tauri.js` entry path.
 * @returns The full `[nodePath, tauriJsPath, ...]` argv tuple.
 * @example
 * ```ts
 * infoArgv("/usr/bin/node", "/.../tauri.js"); // [..., "info"]
 * ```
 */
export function infoArgv(nodePath: string, tauriJsPath: string): readonly string[] {
  return [nodePath, tauriJsPath, "info"];
}
