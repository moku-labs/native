/**
 * @file build plugin — artifact collection. The bundle-location knowledge itself belongs to
 * the project plugin (`project.getBundleLayout`) and arrives here as a {@link BundleLayout};
 * this file only turns it into globs and copies what they match.
 */
import { cp, glob, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BuildFlavor, Target } from "../../config";
import type { BundleLayout } from "../project/layout";
import type { PathResolver } from "./types";

/**
 * Release-flavour Android outputs. Gradle writes every build type side by side
 * (`outputs/apk/<flavour>/<buildType>/`), so an unpinned `outputs/**` glob ships a debug
 * installer. The `**` covers the optional product-flavour directory, `*elease*` both
 * `release` and `universalRelease`.
 */
const ANDROID_APK_PATTERN = "app/build/outputs/apk/**/*elease*/*.apk";

/** The store-bundle equivalent of {@link ANDROID_APK_PATTERN}. */
const ANDROID_AAB_PATTERN = "app/build/outputs/bundle/**/*elease*/*.aab";

/** The unsigned simulator `.app` DIRECTORY `tauri ios build --target <arch>-sim` writes. */
const IOS_SIMULATOR_PATTERN = "build/*-sim/*.app";

/** The signed device archive — one per arch directory, stale ones included (deduplicated). */
const IOS_DEVICE_PATTERN = "build/**/*.ipa";

/**
 * Resolves Tauri's per-target output root the layout's globs are relative to — desktop
 * bundles land under Cargo's `target/release/`, mobile installers under the
 * `gen/<platform>/` tree. Both roots live inside `src-tauri/`.
 *
 * @param projectDirectory - The generated Tauri project root (contains `src-tauri/`).
 * @param layout - The target's bundle layout, from `project.getBundleLayout`.
 * @returns The absolute output root to glob against.
 * @example
 * ```ts
 * bundleRoot("/repo/.moku/tauri", layout); // "/repo/.moku/tauri/src-tauri/target/release"
 * ```
 */
export function bundleRoot(projectDirectory: string, layout: BundleLayout): string {
  return path.join(projectDirectory, layout.root);
}

/** Result of a successful collect pass — where the shippable artifacts landed. */
export type CollectResult = { outPath: string; artifacts: readonly string[] };

/**
 * Collect options — the same {@link BuildFlavor} the build ran with, so the collect phase
 * looks for exactly the artifact that build produced.
 */
export type CollectOptions = BuildFlavor;

/**
 * Everything one collect pass needs beyond its paths: the build flavour, plus the path
 * resolver every containment comparison goes through. The resolver is the project plugin's
 * `resolveDerivedPath` — this phase deletes a destination before copying onto it, and a
 * lexically-contained path can still be a symlink into another tree.
 */
export type CollectInput = CollectOptions & { resolvePath: PathResolver };

/**
 * Picks the glob patterns for one collect pass, relative to {@link bundleRoot}. An iOS
 * simulator build delivers the unsigned `.app` DIRECTORY (`tauri ios build --target
 * <arch>-sim` writes `gen/apple/build/<arch>-sim/<Product Name>.app`, display name and
 * spaces included), an Android store build the `.aab`, every other pass the target's
 * installer(s). Never two flavours at once — a stale device `.ipa` must not ship as a
 * simulator build's artifact, and a stale `.apk` must not ship as a store bundle.
 *
 * @param layout - The target's bundle layout, from `project.getBundleLayout`.
 * @param target - The packaging target being collected.
 * @param opts - Collect options (`simulator` and `aab` each switch a pattern set).
 * @returns The glob patterns to match against {@link bundleRoot}.
 * @example
 * ```ts
 * bundlePatterns(layout, "ios", { simulator: true }); // ["gen/apple/build/*-sim/*.app"]
 * ```
 */
export function bundlePatterns(
  layout: BundleLayout,
  target: Target,
  opts?: CollectOptions
): readonly string[] {
  const gen = layout.genDirectory;
  if (target === "ios" && gen) {
    return [`${gen}/${opts?.simulator === true ? IOS_SIMULATOR_PATTERN : IOS_DEVICE_PATTERN}`];
  }
  if (target === "android" && gen) {
    return [`${gen}/${opts?.aab === true ? ANDROID_AAB_PATTERN : ANDROID_APK_PATTERN}`];
  }
  return layout.formats.map(format => `bundle/${format.directory}/${format.pattern}`);
}

/**
 * Tests whether `child` resolves strictly below `parent` — equality is NOT containment, so a
 * guard built on this can never accept the delivery root itself.
 *
 * @param child - The candidate path (already resolved).
 * @param parent - The directory it must sit below (already resolved).
 * @returns Whether `child` is strictly inside `parent`.
 * @example
 * ```ts
 * isStrictlyInside("/out/macos/App.dmg", "/out/macos"); // true
 * ```
 */
function isStrictlyInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolves where one matched artifact is delivered, and refuses anything that would land
 * outside the target's delivery directory. The collect pass REMOVES this path before copying
 * (a merged copy leaves stale files inside a `.app` bundle and breaks its signature), so both
 * containment facts — delivery directory strictly inside the output directory, destination
 * strictly inside the delivery directory — are established here, before any removal.
 *
 * Both facts are established on REAL paths: `opts.resolvePath` follows symlinks and folds
 * case exactly as the project plugin's clean guard does. A lexical comparison reads
 * `<outDir>/<target>` as contained even when it is a link into an unrelated tree — and the
 * next statement would delete that tree.
 *
 * @param opts - The three paths involved plus the resolver to compare them with.
 * @param opts.outputDirectory - The installer delivery root (`config.outDir`).
 * @param opts.outPath - The target's delivery directory (`<outDir>/<target>`).
 * @param opts.artifactName - The matched artifact's base name.
 * @param opts.resolvePath - `project.resolveDerivedPath` — real path, comparable form.
 * @returns The absolute-or-relative destination path, in the same form as `outPath`.
 * @throws {Error} `[native]` when either path escapes the directory that must contain it.
 * @example
 * ```ts
 * artifactDestination({ outputDirectory: "dist-native", outPath: "dist-native/macos", artifactName: "App.dmg", resolvePath });
 * ```
 */
export function artifactDestination(opts: {
  outputDirectory: string;
  outPath: string;
  artifactName: string;
  resolvePath: PathResolver;
}): string {
  const deliveryRoot = opts.resolvePath(opts.outputDirectory);
  const deliveryDirectory = opts.resolvePath(opts.outPath);
  const destination = path.join(opts.outPath, opts.artifactName);

  if (!isStrictlyInside(deliveryDirectory, deliveryRoot)) {
    throw refuseOutside(opts.outPath, path.resolve(opts.outputDirectory));
  }
  if (!isStrictlyInside(opts.resolvePath(destination), deliveryDirectory)) {
    throw refuseOutside(destination, path.resolve(opts.outPath));
  }
  return destination;
}

/**
 * Builds the `[native]`-formatted refusal for a path that escapes its containing directory.
 *
 * @param offending - The path that escaped.
 * @param root - The directory it had to stay inside.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw refuseOutside("/tmp/evil.dmg", "/repo/dist-native/macos");
 * ```
 */
function refuseOutside(offending: string, root: string): Error {
  return new Error(
    `[native] Refusing to collect "${offending}" outside ${root}.\n  Collect only ever writes inside <outDir>/<target> — check \`outDir\` and the build output.`
  );
}

/**
 * Locates the finished installer(s) for `target` and copies them into `outDir/<target>/` —
 * the stable delivery location `native:complete` reports. Copies with `recursive: true` so
 * a macOS `.app` bundle (a directory) and single-file installers
 * (`.dmg`/`.exe`/`.msi`/`.AppImage`/`.deb`/`.rpm`/`.ipa`/`.aab`/`.apk`) both work through
 * the same call, and REPLACES an existing destination first — `cp` merges into a directory,
 * which would leave stale files inside a `.app` bundle and break its signature. Matches are
 * deduplicated by destination name, keeping the NEWEST one, so stale arch directories cannot
 * put the same installer in the artifact list twice — and cannot ship yesterday's binary
 * either, which is what "whichever the glob happened to yield last" amounted to. Zero
 * matches is an error, never a silent empty success — a shippable artifact is the whole
 * point of this phase.
 *
 * @param projectDirectory - The generated Tauri project root (contains `src-tauri/`).
 * @param target - The packaging target being collected.
 * @param outputDirectory - The installer delivery root (`config.outDir`).
 * @param layout - The target's bundle layout, from `project.getBundleLayout`.
 * @param input - The build flavour (`simulator` collects the iOS `.app` instead of an `.ipa`;
 *   `aab` collects the Android store bundle instead of the `.apk`) plus the path resolver
 *   the containment guard compares with.
 * @returns The delivery directory and the copied artifact paths.
 * @throws {Error} When no glob pattern for `target` matches any file, or when a path escapes
 *   the directory that must contain it.
 * @example
 * ```ts
 * const { outPath } = await collectArtifacts(projectDir, "macos", "dist-native", layout, { resolvePath });
 * ```
 */
export async function collectArtifacts(
  projectDirectory: string,
  target: Target,
  outputDirectory: string,
  layout: BundleLayout,
  input: CollectInput
): Promise<CollectResult> {
  const root = bundleRoot(projectDirectory, layout);
  const patterns = bundlePatterns(layout, target, input);
  const matches = await newestMatchPerName(root, patterns);

  if (matches.size === 0) {
    const globbedRoots = patterns.map(pattern => path.join(root, pattern)).join(", ");
    throw new Error(
      `[native] No ${target} installer artifacts found.\n  Checked ${globbedRoots} — run \`native doctor\` to diagnose the build output.`
    );
  }

  const outPath = path.join(outputDirectory, target);
  await mkdir(outPath, { recursive: true });

  const artifacts: string[] = [];
  for (const [artifactName, match] of matches) {
    const source = path.join(root, match.relativePath);
    const destination = artifactDestination({
      outputDirectory,
      outPath,
      artifactName,
      resolvePath: input.resolvePath
    });
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true });
    artifacts.push(destination);
  }

  return { outPath, artifacts };
}

/** One glob match, with the modification time that decides a name collision. */
type ArtifactMatch = { relativePath: string; modifiedAtMs: number };

/**
 * Globs every pattern and keeps, per destination name, the most recently modified match.
 * A mobile build leaves one directory per arch and never prunes the ones it did not rebuild,
 * so the same installer name legitimately exists several times; the one this build just
 * produced is the newest.
 *
 * @param root - The output root the patterns are relative to.
 * @param patterns - The glob patterns for this target and flavour.
 * @returns The winning match per base name, in first-seen order.
 * @example
 * ```ts
 * await newestMatchPerName(root, ["gen/apple/build/**\/*.ipa"]);
 * ```
 */
async function newestMatchPerName(
  root: string,
  patterns: readonly string[]
): Promise<Map<string, ArtifactMatch>> {
  const matches = new Map<string, ArtifactMatch>();

  for (const pattern of patterns) {
    for await (const relativePath of glob(pattern, { cwd: root })) {
      const name = path.basename(relativePath);
      const modifiedAtMs = await modifiedAt(path.join(root, relativePath));
      const previous = matches.get(name);
      if (previous === undefined || modifiedAtMs > previous.modifiedAtMs) {
        matches.set(name, { relativePath, modifiedAtMs });
      }
    }
  }

  return matches;
}

/**
 * Reads a path's modification time, treating an unreadable path as the oldest possible one
 * so it can never beat a match we could actually stat.
 *
 * @param target - The path to stat.
 * @returns The modification time in milliseconds.
 * @example
 * ```ts
 * await modifiedAt("/repo/.moku/tauri/src-tauri/target/release/bundle/dmg/App.dmg");
 * ```
 */
async function modifiedAt(target: string): Promise<number> {
  try {
    const stats = await stat(target);
    return stats.mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}
