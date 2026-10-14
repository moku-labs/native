/**
 * @file project plugin — the Android adaptive icon inset: wraps the launcher foreground in
 * an `<inset>` so full-bleed art survives the mask. Runs after `tauri icon`, which rewrites
 * these files on every build.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";
import { androidAdaptiveIconDirectory } from "./files";

/** The plain foreground `tauri icon` writes. */
const PLAIN_FOREGROUND = /<foreground\s+android:drawable="([^"]*)"\s*\/>/g;

/** A foreground this patch wrapped, with any inset. */
const INSET_FOREGROUND =
  /<foreground>\s*<inset\s+android:drawable="([^"]*)"\s+android:inset="[^"]*"\s*\/>\s*<\/foreground>/g;

/** The launcher icon files: `ic_launcher.xml`, `ic_launcher_round.xml`. */
const ICON_FILE = /^ic_launcher.*\.xml$/;

/**
 * Applies the inset to one adaptive icon file: any earlier inset is unwrapped first, so a
 * second pass (or a new value) never nests one `<inset>` in another. An unset inset leaves
 * the plain foreground.
 *
 * @param existing - The icon XML.
 * @param inset - Percent per side, or undefined for the plain foreground.
 * @returns The icon XML with the foreground wrapped or plain.
 * @example
 * ```ts
 * applyIconInset('<foreground android:drawable="@mipmap/fg"/>', 19.44);
 * // '<foreground><inset android:drawable="@mipmap/fg" android:inset="19.44%"/></foreground>'
 * ```
 */
export function applyIconInset(existing: string, inset: number | undefined): string {
  const plain = existing.replaceAll(
    INSET_FOREGROUND,
    (_element, drawable: string) => `<foreground android:drawable="${drawable}"/>`
  );
  if (inset === undefined) return plain;
  return plain.replaceAll(
    PLAIN_FOREGROUND,
    (_element, drawable: string) =>
      `<foreground><inset android:drawable="${drawable}" android:inset="${String(inset)}%"/></foreground>`
  );
}

/**
 * Wraps (inset set) or unwraps (inset unset) the foreground of every adaptive launcher
 * icon, in name order, through the write-if-changed writer. A tree whose icons were never
 * generated (no `mipmap-anydpi-v26`) is left alone.
 *
 * @param options - What to patch.
 * @param options.projectDirectory - The Tauri project root.
 * @param options.genDirectory - Absolute `src-tauri/gen/android` path.
 * @param options.inset - Percent per side, or `undefined` to restore the plain form.
 * @returns The icon files patched vs. left unchanged.
 */
export async function patchAndroidIcon(options: {
  projectDirectory: string;
  genDirectory: string;
  inset: number | undefined;
}): Promise<PatchResult> {
  const directory = androidAdaptiveIconDirectory(options.genDirectory);
  if (!existsSync(directory)) return { patched: [], unchanged: [] };

  const patched: string[] = [];
  const unchanged: string[] = [];
  const names = await readdir(directory);
  const files = names.filter(name => ICON_FILE.test(name)).toSorted();
  for (const name of files) {
    const iconPath = path.join(directory, name);
    const next = applyIconInset(await readFile(iconPath, "utf8"), options.inset);
    const action = await writeIfChanged(iconPath, next, options.projectDirectory);
    (action === "written" ? patched : unchanged).push(iconPath);
  }
  return { patched, unchanged };
}
