/**
 * @file build plugin — pure per-target bundle-location table + artifact collection.
 */
import { cp, glob, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Target } from "../../config";

/**
 * Per-target glob patterns locating Tauri's finished installer(s), relative to each
 * target's {@link bundleRoot}. Desktop patterns are relative to `src-tauri/target/release/`
 * (Cargo's release profile output); mobile patterns are relative to `src-tauri/` (the
 * `gen/<platform>` tree `tauri ios|android build` produces).
 */
export const BUNDLE_LOCATIONS: Readonly<Record<Target, readonly string[]>> = {
  macos: ["bundle/dmg/*.dmg", "bundle/macos/*.app"],
  windows: ["bundle/nsis/*-setup.exe", "bundle/msi/*.msi"],
  linux: ["bundle/appimage/*.AppImage", "bundle/deb/*.deb", "bundle/rpm/*.rpm"],
  ios: ["gen/apple/build/**/*.ipa"],
  android: ["gen/android/app/build/outputs/**/*.{aab,apk}"]
};

/**
 * Resolves Tauri's per-target output root that {@link BUNDLE_LOCATIONS} globs are
 * relative to — desktop bundles land under Cargo's `target/release/`; mobile installers
 * land under the mobile `gen/<platform>/` tree. Both roots live inside `src-tauri/`.
 *
 * @param projectDirectory - The generated Tauri project root (contains `src-tauri/`).
 * @param target - The packaging target.
 * @returns The absolute output root to glob {@link BUNDLE_LOCATIONS} patterns against.
 * @example
 * ```ts
 * bundleRoot("/repo/.moku/tauri", "macos"); // "/repo/.moku/tauri/src-tauri/target/release"
 * ```
 */
export function bundleRoot(projectDirectory: string, target: Target): string {
  const srcTauriDirectory = path.join(projectDirectory, "src-tauri");
  if (target === "ios" || target === "android") return srcTauriDirectory;
  return path.join(srcTauriDirectory, "target", "release");
}

/**
 * The iOS SIMULATOR build's output pattern, relative to {@link bundleRoot}. A simulator
 * build is unsigned and never produces an `.ipa`: `tauri ios build --target <arch>-sim`
 * writes `gen/apple/build/<arch>-sim/<Product Name>.app`, a DIRECTORY whose name carries
 * the app's display name (spaces included) — hence the recursive copy (A7).
 */
export const IOS_SIMULATOR_LOCATIONS: readonly string[] = ["gen/apple/build/*-sim/*.app"];

/** Result of a successful collect pass — where the shippable artifacts landed. */
export type CollectResult = { outPath: string; artifacts: readonly string[] };

/** Collect options — a simulator pass looks for the `.app`, never the device `.ipa`. */
export type CollectOptions = { simulator?: boolean | undefined };

/**
 * Picks the glob patterns for one collect pass: an iOS simulator build delivers the
 * unsigned `.app` bundle, every other pass the target's installer(s). Never both —
 * a stale device `.ipa` must not be shipped as a simulator build's artifact (A7).
 *
 * @param target - The packaging target being collected.
 * @param opts - Collect options (`simulator` switches the iOS pattern set).
 * @returns The glob patterns to match against {@link bundleRoot}.
 * @example
 * ```ts
 * bundlePatterns("ios", { simulator: true }); // ["gen/apple/build/*-sim/*.app"]
 * ```
 */
export function bundlePatterns(target: Target, opts?: CollectOptions): readonly string[] {
  if (target === "ios" && opts?.simulator === true) return IOS_SIMULATOR_LOCATIONS;
  return BUNDLE_LOCATIONS[target];
}

/**
 * Locates the finished installer(s) for `target` via {@link BUNDLE_LOCATIONS} and copies
 * them into `outDir/<target>/` — the stable delivery location `native:complete` reports.
 * Copies with `recursive: true` so a macOS `.app` bundle (a directory) and single-file
 * installers (`.dmg`/`.exe`/`.msi`/`.AppImage`/`.deb`/`.rpm`/`.ipa`/`.aab`/`.apk`) both
 * work through the same call. Zero matches is an error, never a silent empty success —
 * a shippable artifact is the whole point of this phase.
 *
 * @param projectDirectory - The generated Tauri project root (contains `src-tauri/`).
 * @param target - The packaging target being collected.
 * @param outputDirectory - The installer delivery root (`config.outDir`).
 * @param opts - Collect options (`simulator` collects the iOS `.app` instead of an `.ipa`).
 * @returns The delivery directory and the copied artifact paths.
 * @throws {Error} When no glob pattern for `target` matches any file.
 * @example
 * ```ts
 * const { outPath, artifacts } = await collectArtifacts("/repo/.moku/tauri", "macos", "dist-native");
 * ```
 */
export async function collectArtifacts(
  projectDirectory: string,
  target: Target,
  outputDirectory: string,
  opts?: CollectOptions
): Promise<CollectResult> {
  const root = bundleRoot(projectDirectory, target);
  const patterns = bundlePatterns(target, opts);

  const matches: string[] = [];
  for (const pattern of patterns) {
    for await (const match of glob(pattern, { cwd: root })) {
      matches.push(match);
    }
  }

  if (matches.length === 0) {
    const globbedRoots = patterns.map(pattern => path.join(root, pattern)).join(", ");
    throw new Error(
      `[native] No ${target} installer artifacts found.\n  Checked ${globbedRoots} — run \`native doctor\` to diagnose the build output.`
    );
  }

  const outPath = path.join(outputDirectory, target);
  await mkdir(outPath, { recursive: true });

  const artifacts: string[] = [];
  for (const match of matches) {
    const source = path.join(root, match);
    const destination = path.join(outPath, path.basename(match));
    await cp(source, destination, { recursive: true });
    artifacts.push(destination);
  }

  return { outPath, artifacts };
}
