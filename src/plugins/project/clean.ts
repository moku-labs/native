/**
 * @file project plugin — target-scoped destructive cleanup (pure path computation + guarded rm).
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { Target } from "../../config";
import { bundleLayout } from "./layout";
import { isDerivedPath, realResolve } from "./paths";
import type { CleanResult } from "./types";

/**
 * Computes the absolute path(s) a clean pass would delete for a given scope, without
 * touching the filesystem. Mobile targets scope to `gen/<platform>` only; desktop
 * targets scope to that target's bundle-FORMAT output directories under Cargo's
 * `target/` (both read from `layout.ts`, the one owner of that table); omitting `target`
 * scopes to the whole project root (D-006: project owns this destructive filesystem
 * knowledge — `cli.clean` is a thin delegate).
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

  const layout = bundleLayout(target);
  if (layout.genDirectory) {
    return [path.resolve(root, layout.root, layout.genDirectory)];
  }
  return layout.formats.map(format => path.resolve(root, layout.root, "bundle", format.directory));
}

/**
 * Refuses to treat anything but derived build output as a cleanable `projectDir`. This is
 * the FIRST gate every clean pass passes through, before a single path is computed.
 *
 * The rule is positive containment, not a blacklist of dangerous paths: `projectDir` must
 * resolve strictly INSIDE the current working directory (or inside the OS temp root, where
 * test and smoke workspaces live), and must not be — or contain — the cwd or the home
 * directory. `~/Documents` is refused for the same reason `/` is: it is not derived state.
 * Symlinks are followed and, on case-insensitive filesystems, case is ignored, so neither
 * a link nor a re-typed capitalization walks around the gate.
 *
 * Pure predicate by design — it is tested by calling it directly with unsafe paths, never
 * by letting {@link clean} loose on one.
 *
 * @param root - The configured `projectDir` a clean pass wants to remove.
 * @param cwd - The current working directory (injectable for tests).
 * @param home - The user's home directory (injectable for tests).
 * @param platform - The host platform, deciding case sensitivity (injectable for tests).
 * @throws {Error} When `root` does not resolve strictly inside the cwd or the temp root, or
 *   when it is, or contains, the cwd or the home directory.
 * @example
 * ```ts
 * assertCleanableRoot("/repo/.moku/tauri", "/repo", "/Users/alex"); // ok
 * assertCleanableRoot("/Users/alex/Documents", "/repo", "/Users/alex"); // throws
 * ```
 */
export function assertCleanableRoot(
  root: string,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform
): void {
  if (isDerivedPath(root, { cwd, home, platform })) return;

  throw new Error(
    `[native] Refusing to clean projectDir "${realResolve(root)}".\n  Set config.projectDir to a dedicated subdirectory such as ".moku/tauri".`
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
 * @throws {Error} When `projectDir` is not derived state inside the cwd or the temp root.
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
