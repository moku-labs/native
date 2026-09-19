/**
 * @file project plugin generators — path helpers shared by the conf and entitlements generators.
 */
import path from "node:path";

/**
 * Rewrites a host-native path with POSIX separators. Every path field in
 * `tauri.conf.json` is POSIX-shaped, on Windows included.
 *
 * @param filePath - A host-native path.
 * @returns The same path with `/` separators.
 * @example
 * ```ts
 * toPosix("..\\..\\dist"); // "../../dist" (on Windows)
 * ```
 */
export function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * Expresses a cwd-relative (or absolute) path the way `tauri.conf.json` reads it: relative
 * to the generated `src-tauri` directory, in POSIX form. Tauri resolves `frontendDist`,
 * `bundle.macOS.entitlements` and friends from `src-tauri`, not from the consumer root.
 *
 * @param projectDirectory - The Tauri project root (contains `src-tauri/`).
 * @param targetPath - The path to express, resolved against the cwd when relative.
 * @returns The POSIX path from `src-tauri` to `targetPath`.
 * @example
 * ```ts
 * relativeToTauriRoot(".moku/tauri", "dist"); // "../../../dist"
 * ```
 */
export function relativeToTauriRoot(projectDirectory: string, targetPath: string): string {
  const srcTauri = path.resolve(projectDirectory, "src-tauri");
  return toPosix(path.relative(srcTauri, path.resolve(targetPath)));
}
