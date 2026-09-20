/**
 * @file project plugin — the ONE owner of the generated tree's layout: Tauri's desktop
 * bundle-FORMAT table and the mobile `gen/<platform>` directory name. Everything that has
 * to find build output (clean, the completeness gate, the mobile patch pass, and build's
 * collect phase through `project.getBundleLayout`) reads it from here.
 */
import path from "node:path";
import type { MobileTarget, Target } from "../../config";

/** A desktop packaging target — the three that bundle through Cargo's release profile. */
export type DesktopTarget = Exclude<Target, MobileTarget>;

/** One bundle format Tauri writes: its output directory, and the artifact glob inside it. */
export type BundleFormat = {
  /** Directory name under `<root>/bundle/`. */
  readonly directory: string;
  /** Glob matching the finished artifact in that directory. */
  readonly pattern: string;
};

/**
 * Tauri's bundle output directories are FORMAT-named, not target-named (`bundle/dmg`,
 * `bundle/nsis`, …), and one desktop target maps to several of them.
 */
const DESKTOP_BUNDLE_FORMATS: Readonly<Record<DesktopTarget, readonly BundleFormat[]>> = {
  macos: [
    { directory: "dmg", pattern: "*.dmg" },
    { directory: "macos", pattern: "*.app" }
  ],
  windows: [
    { directory: "nsis", pattern: "*-setup.exe" },
    { directory: "msi", pattern: "*.msi" }
  ],
  linux: [
    { directory: "appimage", pattern: "*.AppImage" },
    { directory: "deb", pattern: "*.deb" },
    { directory: "rpm", pattern: "*.rpm" }
  ]
};

/** Where one target's build output lives inside the generated project. */
export type BundleLayout = {
  /** Output root, relative to `projectDir`. */
  readonly root: string;
  /** Desktop bundle-format directories under `<root>/bundle/` — empty for a mobile target. */
  readonly formats: readonly BundleFormat[];
  /** The mobile `gen/<platform>` directory relative to `root` — undefined for desktop. */
  readonly genDirectory: string | undefined;
};

/**
 * The `gen/<platform>` subdirectory name Tauri uses for a mobile target (`"apple"` for iOS).
 *
 * @param target - A mobile packaging target.
 * @returns The `gen/<platform>` directory name.
 * @example
 * ```ts
 * genDirectoryName("ios"); // "apple"
 * ```
 */
export function genDirectoryName(target: MobileTarget): "apple" | "android" {
  return target === "ios" ? "apple" : "android";
}

/**
 * Resolves one target's layout: desktop targets bundle under Cargo's `target/release/`,
 * mobile targets under their `gen/<platform>` tree — both inside `src-tauri/`.
 *
 * @param target - The packaging target.
 * @returns The output root, the bundle formats, and the mobile `gen/` directory.
 * @example
 * ```ts
 * bundleLayout("macos"); // { root: "src-tauri/target/release", formats: [dmg, macos], genDirectory: undefined }
 * bundleLayout("ios");   // { root: "src-tauri", formats: [], genDirectory: "gen/apple" }
 * ```
 */
export function bundleLayout(target: Target): BundleLayout {
  if (target === "ios" || target === "android") {
    return { root: "src-tauri", formats: [], genDirectory: `gen/${genDirectoryName(target)}` };
  }
  return {
    root: "src-tauri/target/release",
    formats: DESKTOP_BUNDLE_FORMATS[target],
    genDirectory: undefined
  };
}

/**
 * Resolves the absolute `gen/<platform>` directory of a mobile target inside a generated
 * project. Mobile-only by type, so callers never fall back to an empty path segment for a
 * desktop layout that has no `gen/` tree at all.
 *
 * @param projectDirectory - The Tauri project root (contains `src-tauri/`).
 * @param target - The mobile packaging target.
 * @returns The absolute `src-tauri/gen/<platform>` path.
 * @example
 * ```ts
 * genDirectoryPath("/repo/.moku/tauri", "ios"); // "/repo/.moku/tauri/src-tauri/gen/apple"
 * ```
 */
export function genDirectoryPath(projectDirectory: string, target: MobileTarget): string {
  const layout = bundleLayout(target);
  return path.join(projectDirectory, layout.root, `gen/${genDirectoryName(target)}`);
}
