/**
 * @file project plugin — the app id a mobile `gen/<platform>` tree was initialised for, and
 * setting a tree aside when that id is not the configured one. `tauri android init` bakes the
 * id into the namespace, the `applicationId` and the Kotlin package path; `tauri ios init`
 * bakes it into `project.yml` and the Xcode project. A kept tree never runs init again, so a
 * changed `app.identifier` would otherwise build against the old package or bundle id.
 */
import { existsSync, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import type { MobileTarget } from "../../../config";
import type { StaleTree } from "../types";

/** The key of the `applicationId = "<id>"` line; the debug suffix is a separate line. */
const APPLICATION_ID_KEY = "applicationId";

/** The key of the `PRODUCT_BUNDLE_IDENTIFIER: <id>` line of `project.yml`. */
const BUNDLE_IDENTIFIER_KEY = "PRODUCT_BUNDLE_IDENTIFIER";

/**
 * Reads the `applicationId` a `gen/android` tree was initialised for. Only a quoted literal
 * is recognised, the form `tauri android init` writes; an expression reads as no id.
 *
 * @param genDirectory - The absolute `src-tauri/gen/android` directory.
 * @returns The id, or undefined when `app/build.gradle.kts` is absent or names no literal id.
 * @example
 * ```ts
 * readAndroidApplicationId("/repo/.moku/tauri/src-tauri/gen/android"); // "com.acme.demo"
 * ```
 */
export function readAndroidApplicationId(genDirectory: string): string | undefined {
  const gradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  if (!existsSync(gradlePath)) return undefined;

  // Find the `applicationId = "<id>"` line of the generated Gradle file.
  for (const line of readFileSync(gradlePath, "utf8").split("\n")) {
    const [key, value] = line.split("=", 2).map(part => part.trim());
    if (key === APPLICATION_ID_KEY && value?.startsWith('"')) return value.split('"')[1];
  }
  return undefined;
}

/**
 * Reads the bundle id a `gen/apple` tree was initialised for, from the
 * `PRODUCT_BUNDLE_IDENTIFIER` of its `project.yml` — the file the Xcode project is generated
 * from, so both carry the same id. A quoted value is read without its quotes.
 *
 * @param genDirectory - The absolute `src-tauri/gen/apple` directory.
 * @returns The id, or undefined when `project.yml` is absent or names no bundle id.
 * @example
 * ```ts
 * readAppleBundleIdentifier("/repo/.moku/tauri/src-tauri/gen/apple"); // "com.acme.demo"
 * ```
 */
export function readAppleBundleIdentifier(genDirectory: string): string | undefined {
  const projectPath = path.join(genDirectory, "project.yml");
  if (!existsSync(projectPath)) return undefined;

  // Find the `PRODUCT_BUNDLE_IDENTIFIER: <id>` line of the app setting group.
  for (const line of readFileSync(projectPath, "utf8").split("\n")) {
    const [key, value] = line.split(":", 2).map(part => part.trim());
    if (key === BUNDLE_IDENTIFIER_KEY && value) return value.replaceAll(/["']/g, "");
  }
  return undefined;
}

/**
 * Compares two app ids the way Tauri writes them: a `-` may come out as `_` on Android and
 * a `_` as `-` on Apple.
 *
 * @param left - One id.
 * @param right - The other id.
 * @returns Whether both name the same app.
 */
function sameAppId(left: string, right: string): boolean {
  return left.replaceAll("-", "_") === right.replaceAll("-", "_");
}

/**
 * Picks the first free `<genDirectory>.old-<id>` path, then `-2`, `-3`, … so an earlier
 * set-aside tree is never overwritten.
 *
 * @param genDirectory - The tree being set aside.
 * @param found - The id it was initialised for.
 * @returns A path that does not exist yet.
 */
function freeAsidePath(genDirectory: string, found: string): string {
  const base = `${genDirectory}.old-${found}`;
  let candidate = base;
  let n = 1;
  while (existsSync(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/**
 * Moves a `gen/android` or `gen/apple` tree aside when it was initialised for another app id,
 * so the next `tauri android|ios init` writes a fresh one. The tree is renamed, never deleted:
 * it may hold a keystore or hand edits. A tree whose id cannot be read is left to the
 * completeness gate.
 *
 * @param options - The check options.
 * @param options.target - The mobile platform the tree belongs to.
 * @param options.genDirectory - The absolute `src-tauri/gen/<platform>` directory.
 * @param options.identifier - The configured `app.identifier`.
 * @returns What was found and where it went, or undefined when the tree was kept.
 * @example
 * ```ts
 * await setAsideStaleMobileTree({
 *   target: "android",
 *   genDirectory,
 *   identifier: "studio.kitto.memorymissing"
 * });
 * // { found: "com.mokulabs.memorymissing", expected: "studio.kitto.memorymissing",
 * //   movedTo: ".../gen/android.old-com.mokulabs.memorymissing" }
 * ```
 */
export async function setAsideStaleMobileTree(options: {
  target: MobileTarget;
  genDirectory: string;
  identifier: string;
}): Promise<StaleTree | undefined> {
  const found =
    options.target === "android"
      ? readAndroidApplicationId(options.genDirectory)
      : readAppleBundleIdentifier(options.genDirectory);
  if (found === undefined || sameAppId(found, options.identifier)) return undefined;

  const movedTo = freeAsidePath(options.genDirectory, found);
  await rename(options.genDirectory, movedTo);
  return { found, expected: options.identifier, movedTo };
}
