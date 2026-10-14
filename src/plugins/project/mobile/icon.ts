/**
 * @file project plugin — the Android adaptive icon inset: wraps the launcher foreground in
 * an `<inset>` so full-bleed art survives the mask. Runs after `tauri icon`.
 */
import type { PatchResult } from "../types";

/**
 * Wraps (inset set) or unwraps (inset unset) the adaptive icon foregrounds.
 *
 * @param _options - What to patch.
 * @param _options.genDirectory - Absolute `src-tauri/gen/android` path.
 * @param _options.inset - Percent per side, or `undefined` to restore the plain form.
 * @example
 * ```ts
 * await patchAndroidIcon({ genDirectory, inset: 19.44 });
 * ```
 */
export async function patchAndroidIcon(_options: {
  genDirectory: string;
  inset: number | undefined;
}): Promise<PatchResult> {
  throw new Error("not implemented");
}
