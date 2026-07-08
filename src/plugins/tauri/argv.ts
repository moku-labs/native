/**
 * @file tauri plugin — pure per-verb argv builders (spike (b): D-013 invocation shape).
 *
 * Every builder returns the FULL argv tuple already prefixed with
 * `[nodePath, tauriJsPath, ...]` — callers never assemble the prefix themselves.
 * No `tauri init` verb exists here by design (D-013) — only `ios|android init`.
 */
import type { Target } from "../../config";

/**
 * Builds the argv for `tauri build` / `tauri ios|android build`.
 *
 * Android defaults to `--apk` (directly installable artifact) rather than
 * `--aab` (store-submission bundle) — callers needing an AAB compose their
 * own build-plugin option; this seam stays a pure function of `target`.
 *
 * @param nodePath - Resolved `node` binary path.
 * @param tauriJsPath - Resolved `@tauri-apps/cli/tauri.js` entry path.
 * @param target - Packaging target.
 * @returns The full `[nodePath, tauriJsPath, ...]` argv tuple.
 * @example
 * ```ts
 * buildArgv("/usr/bin/node", "/.../tauri.js", "ios"); // [..., "ios", "build", "--ci"]
 * ```
 */
export function buildArgv(
  nodePath: string,
  tauriJsPath: string,
  target: Target
): readonly string[] {
  const prefix = [nodePath, tauriJsPath];
  if (target === "ios") return [...prefix, "ios", "build", "--ci"];
  if (target === "android") return [...prefix, "android", "build", "--ci", "--apk"];
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
 * @param nodePath - Resolved `node` binary path.
 * @param tauriJsPath - Resolved `@tauri-apps/cli/tauri.js` entry path.
 * @param source - Path to the source icon image.
 * @returns The full `[nodePath, tauriJsPath, ...]` argv tuple.
 * @example
 * ```ts
 * iconArgv("/usr/bin/node", "/.../tauri.js", "icon.png"); // [..., "icon", "icon.png"]
 * ```
 */
export function iconArgv(nodePath: string, tauriJsPath: string, source: string): readonly string[] {
  return [nodePath, tauriJsPath, "icon", source];
}

/**
 * Builds the argv for `tauri ios|android init` — the ONLY init verbs (D-013);
 * plain `tauri init` is never used since the desktop tree is project-generated.
 *
 * @param nodePath - Resolved `node` binary path.
 * @param tauriJsPath - Resolved `@tauri-apps/cli/tauri.js` entry path.
 * @param platform - Mobile platform to initialize.
 * @returns The full `[nodePath, tauriJsPath, ...]` argv tuple.
 * @example
 * ```ts
 * mobileInitArgv("/usr/bin/node", "/.../tauri.js", "ios"); // [..., "ios", "init", "--ci"]
 * ```
 */
export function mobileInitArgv(
  nodePath: string,
  tauriJsPath: string,
  platform: "ios" | "android"
): readonly string[] {
  return [nodePath, tauriJsPath, platform, "init", "--ci"];
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
