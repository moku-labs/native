/**
 * @file project plugin — the embedded placeholder app icon.
 */
import { Buffer } from "node:buffer";

/**
 * A valid 1024x1024 solid-colour PNG (`#1F2430`, 1-bit indexed, fully opaque), built once
 * with `node:zlib` and verified with `sips -g pixelWidth -g pixelHeight` and a real
 * `tauri icon` run. It is this small because the image is one flat colour.
 *
 * `tauri build` refuses to bundle without an icon set, so an app that has not drawn one
 * yet still needs SOME valid square PNG to feed `tauri icon` — this is it.
 */
const PLACEHOLDER_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAABAAAAAQAAQMAAABF07nAAAAABlBMVEUfJDAfJDBTxk2jAAAAAnRSTlP//8i138cAAAIaSU" +
  "RVHja7c4xDQAAAAIgZ//QxvCBBCRnFRAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
  "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
  "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
  "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
  "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
  "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
  "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
  "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEHgHBnjwB/8eKZFUAAAAAElFTkSuQmCC";

/**
 * Decodes the embedded placeholder icon into the PNG bytes `ensureIconSource` writes to
 * `<projectDir>/placeholder-icon.png`.
 *
 * @returns The placeholder icon's PNG bytes — a fresh buffer on every call.
 * @example
 * ```ts
 * await writeIfChanged(iconPath, placeholderIconPng(), projectDir);
 * ```
 */
export function placeholderIconPng(): Uint8Array {
  return Buffer.from(PLACEHOLDER_ICON_BASE64, "base64");
}
