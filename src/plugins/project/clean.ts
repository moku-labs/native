/**
 * @file project plugin — target-scoped destructive cleanup (pure path computation + guarded rm).
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
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
 * Refuses to treat a shared, non-derived directory as a cleanable `projectDir`. This is
 * the FIRST gate every clean pass passes through, before a single path is computed:
 * `projectDir` is gitignored build output, so a `projectDir` that is the current working
 * directory, the user's home directory, a filesystem root, or an ancestor of the current
 * working directory is a misconfiguration, not a clean scope.
 *
 * Pure predicate by design — it is tested by calling it directly with unsafe paths, never
 * by letting {@link clean} loose on one.
 *
 * @param root - The configured `projectDir` a clean pass wants to remove.
 * @param cwd - The current working directory (injectable for tests).
 * @param home - The user's home directory (injectable for tests).
 * @throws {Error} When `root` is the cwd, the home directory, a filesystem root, or contains the cwd.
 * @example
 * ```ts
 * assertCleanableRoot("/repo/.moku/tauri", "/repo", "/Users/alex"); // ok
 * assertCleanableRoot("/repo", "/repo", "/Users/alex"); // throws
 * ```
 */
export function assertCleanableRoot(
  root: string,
  cwd: string = process.cwd(),
  home: string = os.homedir()
): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCwd = path.resolve(cwd);

  const isFilesystemRoot = path.dirname(resolvedRoot) === resolvedRoot;
  const isCwd = resolvedRoot === resolvedCwd;
  const isHome = resolvedRoot === path.resolve(home);
  const containsCwd = resolvedCwd.startsWith(resolvedRoot + path.sep);
  if (!isFilesystemRoot && !isCwd && !isHome && !containsCwd) return;

  throw new Error(
    `[native] Refusing to clean projectDir "${resolvedRoot}".\n  Set config.projectDir to a dedicated subdirectory such as ".moku/tauri".`
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
 * removes that target's bundle output. `projectDir` itself is checked by
 * {@link assertCleanableRoot} before anything is computed — for BOTH the scoped and the
 * unscoped case — and every candidate path is then validated against `projectDir`, so
 * only existing paths inside a legitimately derived root are removed/reported.
 *
 * @param projectDirectory - The Tauri project root.
 * @param target - The optional packaging target to scope the clean to.
 * @returns The list of paths actually removed.
 * @throws {Error} When `projectDir` is the cwd, the home directory, a filesystem root, or contains the cwd.
 * @example
 * ```ts
 * await clean("/repo/.moku/tauri", "android");
 * ```
 */
export async function clean(projectDirectory: string, target?: Target): Promise<CleanResult> {
  const root = path.resolve(projectDirectory);
  assertCleanableRoot(root);

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
