/**
 * @file project plugin — mobile gen/-tree required-file completeness gate.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { MobileTarget, Target } from "../../../config";
import { bundleLayout } from "../layout";
import type { CompletenessResult } from "../types";

/**
 * Required top-level entries per mobile `gen/<platform>` tree (Tauri 2.9.x scaffolding).
 * A partial init (tauri#13902) can leave some of these absent — `completeness` checks
 * the required-file SET, not mere directory existence.
 */
const REQUIRED_FILES: Readonly<Record<MobileTarget, readonly string[]>> = {
  ios: ["project.yml", "Assets.xcassets", "Sources", "ExportOptions.plist"],
  android: [
    "build.gradle.kts",
    "settings.gradle.kts",
    "gradle.properties",
    "app/build.gradle.kts",
    "app/src/main/AndroidManifest.xml"
  ]
};

/**
 * Returns the required-file set for a mobile platform — consumed by `doctor` and by
 * `completeness` itself.
 *
 * @param platform - The mobile platform.
 * @returns The frozen list of required paths, relative to `src-tauri/gen/<platform>`.
 * @example
 * ```ts
 * requiredFiles("android"); // ["build.gradle.kts", "settings.gradle.kts", ...]
 * ```
 */
export function requiredFiles(platform: MobileTarget): readonly string[] {
  return REQUIRED_FILES[platform];
}

/**
 * Checks the mobile `gen/<platform>` tree against its required-file set. Desktop
 * targets are not-applicable (no gen/ tree). Returns "not-initialized" when the gen/
 * directory itself is absent, "incomplete" with the missing subset for a partial init,
 * or "complete" when every required file/directory is present.
 *
 * @param projectDirectory - The Tauri project root (contains `src-tauri/`).
 * @param target - The packaging target being checked.
 * @returns The completeness verdict.
 * @example
 * ```ts
 * completeness("/repo/.moku/tauri", "android"); // { status: "complete" }
 * ```
 */
export function completeness(projectDirectory: string, target: Target): CompletenessResult {
  if (target !== "ios" && target !== "android") {
    return { status: "not-applicable" };
  }

  const layout = bundleLayout(target);
  const genDirectory = path.join(projectDirectory, layout.root, layout.genDirectory ?? "");
  if (!existsSync(genDirectory)) {
    return { status: "not-initialized" };
  }

  const missing = REQUIRED_FILES[target].filter(file => !existsSync(path.join(genDirectory, file)));
  if (missing.length > 0) {
    return { status: "incomplete", missing };
  }

  return { status: "complete" };
}
