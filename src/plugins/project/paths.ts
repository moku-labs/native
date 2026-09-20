/**
 * @file project plugin — the ONE path normalization/containment helper.
 *
 * Both path gates in this plugin ask the same question — "is this a derived directory this
 * app is allowed to own?" — and both must answer it identically: the composition-time
 * config check (`validate.ts`) is only a real safety net if it accepts exactly what the
 * destructive clean guard (`clean.ts`) accepts. They therefore share this module rather
 * than each rolling their own resolve/compare, and so does build's collect guard, through
 * `project.resolveDerivedPath`.
 *
 * Two rules, because the two configured directories carry different risk: `projectDir` is
 * deleted recursively ({@link isDerivedPath}), `outDir` only receives files
 * ({@link isDeliveryPath}).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Platforms whose filesystems compare paths case-insensitively. On those, `"/Repo"` and
 * `"/repo"` are the same directory, so a case-sensitive guard is bypassed by typing the
 * config value in a different case.
 */
const CASE_INSENSITIVE_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "win32"]);

/** Directory entry that marks a checkout root. */
const GIT_ENTRY = ".git";

/** Manifest whose `workspaces` field marks a monorepo root. */
const PACKAGE_MANIFEST = "package.json";

/** The `workspaces` key inside a package manifest — bounded, this runs over untrusted text. */
const WORKSPACES_FIELD_PATTERN = /"workspaces"\s{0,8}:/;

/**
 * The two filesystem facts the anchor walk needs. Injectable so the walk itself is a pure
 * function over plain strings — the tests describe a repository layout without creating one.
 */
export type AnchorProbe = {
  /** Whether a directory entry (file, directory or link) exists at `target`. */
  hasEntry(target: string): boolean;
  /** The text content of `target`, or `undefined` when it is absent or unreadable. */
  readText(target: string): string | undefined;
};

/**
 * The boundaries a candidate path is judged against. Every one is injectable so the
 * predicates can be unit-tested with plain strings — an unsafe path is never created on
 * disk, let alone handed to a destructive function.
 */
export type PathBoundaries = {
  /** The current working directory — where the script happens to have been started. */
  cwd: string;
  /** The user's home directory — never cleanable, and never an ancestor of one. */
  home: string;
  /** The OS temp root — the second allowed root (test workspaces live here). */
  temporaryRoot: string;
  /** `process.platform`-shaped value deciding case sensitivity. */
  platform: NodeJS.Platform;
  /** The project root containment is measured against (default: {@link containmentAnchor}). */
  anchor: string;
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
 * Resolves `target` all the way to the single form two paths may be compared in: absolute,
 * symlinks followed, NFC-normalized, and case-folded on a case-insensitive platform. Every
 * containment guard in this framework — the config check, the clean guard, build's collect
 * guard — compares in exactly this form, so none of them can be walked around by a link or
 * a re-typed capitalization.
 *
 * For comparison only: the result is never a path to display or to hand to the filesystem.
 *
 * @param target - The path to resolve, absolute or relative to the process cwd.
 * @param platform - The platform whose case rules apply (default: the host's).
 * @returns The comparable form of the real path.
 * @example
 * ```ts
 * comparableRealPath("dist-native/macos", "darwin"); // "/repo/app/dist-native/macos"
 * ```
 */
export function comparableRealPath(
  target: string,
  platform: NodeJS.Platform = process.platform
): string {
  return comparablePath(realResolve(target), platform);
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
 * Reads a file, treating an absent, unreadable or non-file path as "no content" — a
 * directory without a `package.json` is the normal case on the way up, not an error.
 *
 * @param target - The file to read.
 * @returns The file's text, or undefined when there is none to read.
 * @example
 * ```ts
 * readTextIfPresent("/repo/package.json");
 * ```
 */
function readTextIfPresent(target: string): string | undefined {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

/** The real {@link AnchorProbe} — the only impure part of the anchor walk. */
const realAnchorProbe: AnchorProbe = { hasEntry: existsSync, readText: readTextIfPresent };

/**
 * Tests whether one directory is a project root: it carries a `.git` entry, or a
 * `package.json` declaring `workspaces`.
 *
 * @param directory - The directory to inspect.
 * @param probe - The filesystem probe to ask.
 * @returns Whether the directory is a project root.
 * @example
 * ```ts
 * isProjectRoot("/repo", realAnchorProbe); // true
 * ```
 */
function isProjectRoot(directory: string, probe: AnchorProbe): boolean {
  if (probe.hasEntry(path.join(directory, GIT_ENTRY))) return true;

  const manifest = probe.readText(path.join(directory, PACKAGE_MANIFEST));
  return manifest !== undefined && WORKSPACES_FIELD_PATTERN.test(manifest);
}

/**
 * Finds the project root that containment is measured against: the nearest ancestor of the
 * cwd (the cwd itself included) carrying a `.git` entry or a workspaces `package.json`.
 *
 * The cwd alone is the wrong anchor. A monorepo script runs from `packages/app` while its
 * configured `projectDir` is an absolute path under the repository root — measured against
 * the cwd that reads as "outside the project" and the app refuses to build. The walk stops
 * BEFORE the home directory and before a filesystem root: a dotfiles repo in `$HOME` must
 * never make the whole home directory the project. With no marker anywhere, the cwd stands.
 *
 * @param cwd - The current working directory.
 * @param home - The user's home directory — the walk never reaches or passes it.
 * @param platform - The platform whose case rules apply.
 * @param probe - The filesystem probe (injectable: the walk is pure over plain strings).
 * @returns The absolute, symlink-resolved anchor directory.
 * @example
 * ```ts
 * containmentAnchor("/repo/packages/app", "/Users/alex"); // "/repo"
 * ```
 */
export function containmentAnchor(
  cwd: string = process.cwd(),
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  probe: AnchorProbe = realAnchorProbe
): string {
  const start = realResolve(cwd);
  const homeDirectory = comparablePath(realResolve(home), platform);

  let current = start;
  while (path.dirname(current) !== current && comparablePath(current, platform) !== homeDirectory) {
    if (isProjectRoot(current, probe)) return current;
    current = path.dirname(current);
  }
  return start;
}

/**
 * Tests whether a temp root grants anything at all. `os.tmpdir()` reads `TMPDIR`, so this
 * second allowed root is consumer-controlled: pointed at a filesystem root it would bless
 * every path on the disk, and pointed at (or above) the home directory it would bless the
 * whole home. Such a temp root grants nothing rather than everything.
 *
 * @param temporaryDirectory - The resolved temp root.
 * @param homeDirectory - The resolved home directory.
 * @param platform - The platform whose case rules apply.
 * @returns Whether paths inside the temp root may be treated as derived state.
 * @example
 * ```ts
 * grantsDerivedPaths("/private/var/folders/x", "/Users/alex", "darwin"); // true
 * ```
 */
function grantsDerivedPaths(
  temporaryDirectory: string,
  homeDirectory: string,
  platform: NodeJS.Platform
): boolean {
  if (path.dirname(temporaryDirectory) === temporaryDirectory) return false;
  return !isSameOrInside(temporaryDirectory, homeDirectory, platform);
}

/**
 * Decides whether a configured directory is derived state this app may own outright, and
 * therefore delete recursively — positive containment, not a blacklist: the path must
 * resolve strictly INSIDE the project anchor (see {@link containmentAnchor}) or inside a
 * usable OS temp root (test and smoke workspaces are `mkdtemp` directories there), and must
 * not be, nor contain, the anchor, the cwd or the home directory, nor be a filesystem root.
 *
 * A directory that merely fails to be one of the known-dangerous paths — `~/Documents`, a
 * sibling checkout — is NOT derived state, and is rejected.
 *
 * @param candidate - The configured directory (`projectDir`), absolute or relative.
 * @param boundaries - Overrides for cwd/home/tmp/platform/anchor; each defaults to the real value.
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
  const anchor =
    boundaries.anchor === undefined
      ? containmentAnchor(workingDirectory, homeDirectory, platform)
      : realResolve(boundaries.anchor);

  // Shared, non-derived roots: the path IS one of them, or it swallows one.
  if (path.dirname(root) === root) return false;
  if (isSameOrInside(root, anchor, platform)) return false;
  if (isSameOrInside(root, workingDirectory, platform)) return false;
  if (isSameOrInside(root, homeDirectory, platform)) return false;

  if (isStrictlyInside(anchor, root, platform)) return true;
  return (
    grantsDerivedPaths(temporaryDirectory, homeDirectory, platform) &&
    isStrictlyInside(temporaryDirectory, root, platform)
  );
}

/**
 * Decides whether a configured directory may receive delivered artifacts. Looser than
 * {@link isDerivedPath} on purpose: a delivery directory is written into and replaced file
 * by file, never recursively cleaned, so the "inside the project" rule that protects
 * `projectDir` only breaks legitimate setups here — a CI cache mount, an artifacts volume,
 * a shared output directory all live outside the checkout.
 *
 * Three refusals remain, and they are the ones that matter for a directory this app writes
 * into: a filesystem root, the home directory itself, and any ancestor of the cwd or of the
 * home directory.
 *
 * @param candidate - The configured delivery directory (`outDir`), absolute or relative.
 * @param boundaries - Overrides for cwd/home/platform; each defaults to the real value.
 * @returns Whether artifacts may be delivered there.
 * @example
 * ```ts
 * isDeliveryPath("dist-native"); // true
 * isDeliveryPath("/"); // false
 * ```
 */
export function isDeliveryPath(
  candidate: string,
  boundaries: Partial<PathBoundaries> = {}
): boolean {
  const { cwd = process.cwd(), home = os.homedir(), platform = process.platform } = boundaries;

  const root = realResolve(candidate);
  const workingDirectory = realResolve(cwd);
  const homeDirectory = realResolve(home);

  if (path.dirname(root) === root) return false;
  if (isSameOrInside(root, homeDirectory, platform)) return false;
  return !isStrictlyInside(root, workingDirectory, platform);
}
