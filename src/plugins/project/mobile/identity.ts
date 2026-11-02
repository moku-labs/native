/**
 * @file project plugin — the app id a `gen/android` tree was initialised for, and setting a
 * tree aside when that id is not the configured one. `tauri android init` bakes the id into
 * the namespace, the `applicationId` and the Kotlin package path; a kept tree never runs
 * init again, so a changed `app.identifier` would otherwise build against the old package.
 */
import { existsSync, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import type { StaleTree } from "../types";

/** The key of the `applicationId = "<id>"` line; the debug suffix is a separate line. */
const APPLICATION_ID_KEY = "applicationId";

/**
 * Reads the `applicationId` a `gen/android` tree was initialised for.
 *
 * @param genDirectory - The absolute `src-tauri/gen/android` directory.
 * @returns The id, or undefined when `app/build.gradle.kts` is absent or names none.
 * @example
 * ```ts
 * readAndroidApplicationId("/repo/.moku/tauri/src-tauri/gen/android"); // "com.acme.demo"
 * ```
 */
export function readAndroidApplicationId(genDirectory: string): string | undefined {
  const gradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  if (!existsSync(gradlePath)) return undefined;
  for (const line of readFileSync(gradlePath, "utf8").split("\n")) {
    const [key, value] = line.split("=", 2).map(part => part.trim());
    if (key === APPLICATION_ID_KEY && value?.startsWith('"')) return value.split('"')[1];
  }
  return undefined;
}

/**
 * Compares two Android ids the way Tauri writes them: a `-` may come out as `_`.
 *
 * @param left - One id.
 * @param right - The other id.
 * @returns Whether both name the same app.
 */
function sameAndroidId(left: string, right: string): boolean {
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
 * Moves a `gen/android` tree aside when it was initialised for another app id, so the next
 * `tauri android init` writes a fresh one. The tree is renamed, never deleted: it may hold a
 * keystore or hand edits. A tree whose id cannot be read is left to the completeness gate.
 *
 * @param options - The check options.
 * @param options.genDirectory - The absolute `src-tauri/gen/android` directory.
 * @param options.identifier - The configured `app.identifier`.
 * @returns What was found and where it went, or undefined when the tree was kept.
 * @example
 * ```ts
 * await setAsideStaleAndroidTree({ genDirectory, identifier: "studio.kitto.memorymissing" });
 * // { found: "com.mokulabs.memorymissing", expected: "studio.kitto.memorymissing",
 * //   movedTo: ".../gen/android.old-com.mokulabs.memorymissing" }
 * ```
 */
export async function setAsideStaleAndroidTree(options: {
  genDirectory: string;
  identifier: string;
}): Promise<StaleTree | undefined> {
  const found = readAndroidApplicationId(options.genDirectory);
  if (found === undefined || sameAndroidId(found, options.identifier)) return undefined;

  const movedTo = freeAsidePath(options.genDirectory, found);
  await rename(options.genDirectory, movedTo);
  return { found, expected: options.identifier, movedTo };
}
