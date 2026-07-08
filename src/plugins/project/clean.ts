/**
 * @file project plugin — target-scoped destructive cleanup (pure path computation + guarded rm).
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Target } from "../../config";
import type { CleanResult } from "./types";

/**
 * Tauri's bundle output directories are FORMAT-named, not target-named
 * (`bundle/dmg`, `bundle/nsis`, …) — one desktop target maps to several
 * format directories (same table spec 03-build's collect phase reads).
 */
const DESKTOP_BUNDLE_FORMATS: Record<Exclude<Target, "ios" | "android">, readonly string[]> = {
  macos: ["dmg", "macos"],
  windows: ["nsis", "msi"],
  linux: ["appimage", "deb", "rpm"]
};

/**
 * Computes the absolute path(s) a clean pass would delete for a given scope, without
 * touching the filesystem. Mobile targets scope to `gen/<platform>` only; desktop
 * targets scope to that target's bundle-FORMAT output directories under Cargo's
 * `target/` (Tauri names bundle dirs by format — dmg/nsis/appimage/… — never by
 * target); omitting `target` scopes to the whole project root (D-006: project owns
 * this destructive filesystem knowledge — `cli.clean` is a thin delegate).
 *
 * @param projectDirectory - The Tauri project root.
 * @param target - The optional packaging target to scope the clean to.
 * @returns The list of absolute paths this clean pass would remove.
 * @example
 * ```ts
 * cleanTargets("/repo/.moku/tauri", "android"); // ["/repo/.moku/tauri/src-tauri/gen/android"]
 * cleanTargets("/repo/.moku/tauri", "windows"); // [...bundle/nsis, ...bundle/msi]
 * ```
 */
export function cleanTargets(projectDirectory: string, target?: Target): string[] {
  const root = path.resolve(projectDirectory);
  if (!target) return [root];
  if (target === "ios" || target === "android") {
    const platform = target === "ios" ? "apple" : "android";
    return [path.resolve(root, "src-tauri", "gen", platform)];
  }
  return DESKTOP_BUNDLE_FORMATS[target].map(format =>
    path.resolve(root, "src-tauri", "target", "release", "bundle", format)
  );
}

/**
 * Refuses to operate on a path outside `root` — the last line of defense before any
 * destructive filesystem call in this plugin.
 *
 * @param root - The resolved project root that every clean target must stay within.
 * @param candidate - The resolved path a clean pass wants to remove.
 * @throws {Error} When `candidate` is not `root` itself and not nested under it.
 * @example
 * ```ts
 * assertWithinRoot("/repo/.moku/tauri", "/repo/.moku/tauri/src-tauri/gen/android"); // ok
 * assertWithinRoot("/repo/.moku/tauri", "/etc/passwd"); // throws
 * ```
 */
export function assertWithinRoot(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(
      `[native] Refusing to clean path outside projectDir: ${candidate}.\n  Check the projectDir/target configuration before retrying.`
    );
  }
}

/**
 * Deletes derived state for the given scope. `target` omitted removes the whole
 * `projectDir`; a mobile `target` removes `gen/<platform>` only; a desktop `target`
 * removes that target's bundle output. Every candidate path is validated against
 * `projectDir` before deletion, and only paths that actually exist are removed/reported.
 *
 * @param projectDirectory - The Tauri project root.
 * @param target - The optional packaging target to scope the clean to.
 * @returns The list of paths actually removed.
 * @example
 * ```ts
 * await clean("/repo/.moku/tauri", "android");
 * ```
 */
export async function clean(projectDirectory: string, target?: Target): Promise<CleanResult> {
  const root = path.resolve(projectDirectory);
  const removed: string[] = [];

  for (const candidate of cleanTargets(projectDirectory, target)) {
    assertWithinRoot(root, candidate);
    if (existsSync(candidate)) {
      await rm(candidate, { recursive: true, force: true });
      removed.push(candidate);
    }
  }

  return { removed };
}
