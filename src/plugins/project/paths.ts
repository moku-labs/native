/**
 * @file project plugin — the ONE path normalization/containment helper.
 *
 * Both path gates in this plugin ask the same question — "is this a derived directory this
 * app is allowed to own?" — and both must answer it identically: the composition-time
 * config check (`validate.ts`) is only a real safety net if it accepts exactly what the
 * destructive clean guard (`clean.ts`) accepts. They therefore share this module rather
 * than each rolling their own resolve/compare.
 */
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Platforms whose filesystems compare paths case-insensitively. On those, `"/Repo"` and
 * `"/repo"` are the same directory, so a case-sensitive guard is bypassed by typing the
 * config value in a different case.
 */
const CASE_INSENSITIVE_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "win32"]);

/**
 * The boundaries a candidate path is judged against. Every one is injectable so the
 * predicates can be unit-tested with plain strings — an unsafe path is never created on
 * disk, let alone handed to a destructive function.
 */
export type PathBoundaries = {
  /** The current working directory — the primary allowed root. */
  cwd: string;
  /** The user's home directory — never cleanable, and never an ancestor of one. */
  home: string;
  /** The OS temp root — the second allowed root (test workspaces live here). */
  temporaryRoot: string;
  /** `process.platform`-shaped value deciding case sensitivity. */
  platform: NodeJS.Platform;
};

/**
 * Resolves `target` to an absolute path with symlinks followed. A path that does not exist
 * yet (a `projectDir` before the first build) still gets its deepest EXISTING ancestor
 * realpath'd, so `<symlink-to-elsewhere>/.moku/tauri` is judged where it really lands
 * rather than where it lexically reads.
 *
 * @param target - The path to resolve, absolute or relative to the process cwd.
 * @returns The absolute, symlink-resolved path.
 * @example
 * ```ts
 * realResolve(".moku/tauri"); // "/repo/app/.moku/tauri"
 * ```
 */
export function realResolve(target: string): string {
  const resolved = path.resolve(target);

  let existing = resolved;
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }

  try {
    return path.join(realpathSync(existing), ...missingSegments);
  } catch {
    return resolved;
  }
}

/**
 * Normalizes a path for comparison: NFC (so a decomposed macOS filename and the composed
 * string a consumer typed compare equal) plus lowercasing on case-insensitive platforms.
 *
 * @param target - An already-resolved absolute path.
 * @param platform - The platform whose case rules apply.
 * @returns The comparable form — for equality/prefix tests only, never for display.
 * @example
 * ```ts
 * comparablePath("/Repo/App", "darwin"); // "/repo/app"
 * ```
 */
function comparablePath(target: string, platform: NodeJS.Platform): string {
  const normalized = target.normalize("NFC");
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? normalized.toLowerCase() : normalized;
}

/**
 * Tests whether `candidate` sits strictly BELOW `parent` — nested, never equal, and never
 * a sibling that merely shares a prefix (`/repo/app-other` is not inside `/repo/app`).
 *
 * @param parent - The containing directory.
 * @param candidate - The path being placed.
 * @param platform - The platform whose case rules apply.
 * @returns Whether `candidate` is nested inside `parent`.
 * @example
 * ```ts
 * isStrictlyInside("/repo/app", "/repo/app/.moku", "linux"); // true
 * ```
 */
export function isStrictlyInside(
  parent: string,
  candidate: string,
  platform: NodeJS.Platform
): boolean {
  const comparableParent = comparablePath(parent, platform);
  const comparableCandidate = comparablePath(candidate, platform);
  if (comparableParent === comparableCandidate) return false;

  // A filesystem root already ends with the separator; anything else needs one appended,
  // so a sibling sharing a prefix ("/repo/app-other") is not read as "inside".
  const prefix = comparableParent.endsWith(path.sep)
    ? comparableParent
    : comparableParent + path.sep;
  return comparableCandidate.startsWith(prefix);
}

/**
 * Tests whether `candidate` IS `parent` or sits inside it.
 *
 * @param parent - The containing directory.
 * @param candidate - The path being placed.
 * @param platform - The platform whose case rules apply.
 * @returns Whether `candidate` is `parent` itself or nested inside it.
 * @example
 * ```ts
 * isSameOrInside("/repo/app", "/repo/app", "linux"); // true
 * ```
 */
function isSameOrInside(parent: string, candidate: string, platform: NodeJS.Platform): boolean {
  return (
    comparablePath(parent, platform) === comparablePath(candidate, platform) ||
    isStrictlyInside(parent, candidate, platform)
  );
}

/**
 * Decides whether a configured directory is derived state this app may own outright —
 * positive containment, not a blacklist: the path must resolve strictly INSIDE the current
 * working directory or inside the OS temp root (test and smoke workspaces are `mkdtemp`
 * directories there), and must not be, nor contain, the cwd or the home directory, nor be
 * a filesystem root.
 *
 * A directory that merely fails to be one of the known-dangerous paths — `~/Documents`, a
 * sibling checkout — is NOT derived state, and is rejected.
 *
 * @param candidate - The configured directory (`projectDir`, `outDir`), absolute or relative.
 * @param boundaries - Overrides for cwd/home/tmp/platform; each defaults to the real value.
 * @returns Whether the path may be treated as this app's derived output.
 * @example
 * ```ts
 * isDerivedPath(".moku/tauri"); // true
 * isDerivedPath("/Users/alex/Documents"); // false
 * ```
 */
export function isDerivedPath(
  candidate: string,
  boundaries: Partial<PathBoundaries> = {}
): boolean {
  const {
    cwd = process.cwd(),
    home = os.homedir(),
    temporaryRoot = os.tmpdir(),
    platform = process.platform
  } = boundaries;

  const root = realResolve(candidate);
  const workingDirectory = realResolve(cwd);
  const homeDirectory = realResolve(home);
  const temporaryDirectory = realResolve(temporaryRoot);

  // Shared, non-derived roots: the path IS one of them, or it swallows one.
  if (path.dirname(root) === root) return false;
  if (isSameOrInside(root, workingDirectory, platform)) return false;
  if (isSameOrInside(root, homeDirectory, platform)) return false;

  return (
    isStrictlyInside(workingDirectory, root, platform) ||
    isStrictlyInside(temporaryDirectory, root, platform)
  );
}
