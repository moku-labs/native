/**
 * @file project plugin — the Android system bar patch. The generated MainActivity.kt
 * calls `enableEdgeToEdge()`, whose default `SystemBarStyle.auto` picks the status bar
 * icon colour from the SYSTEM night mode, not from the app. A dark app on a light-mode
 * phone then gets dark icons on a dark page. When `app.backgroundColor` is set, this patch
 * rewrites that one call so the icons follow the colour's luminance instead.
 *
 * The transform is a pure text function: only the call and the two imports it needs
 * change, every other byte (line endings included) survives, a second pass is a no-op, and
 * unsetting the colour restores the generated call.
 */
import { readFile } from "node:fs/promises";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";
import { androidJavaDirectory, androidMainActivityFiles } from "./files";

/** Whether a background is dark (it wants light icons) or light (it wants dark icons). */
export type SystemBarTone = "dark" | "light";

/** One import the styled call needs, and the pattern that shows code still uses it. */
type StyleImport = {
  /** The whole import line, as this patch writes it. */
  readonly line: string;
  /** Matches a use of the imported name outside the import lines. */
  readonly usage: RegExp;
};

/**
 * A background whose relative luminance is below this is dark, so it gets light icons.
 * Where white and black icons have equal WCAG contrast: sqrt(1.05 * 0.05) - 0.05.
 */
const DARK_LUMINANCE_THRESHOLD = 0.179;

/** `#rrggbb` or `#rrggbbaa`, the three colour channels captured; alpha is ignored. */
const HEX_CHANNELS_PATTERN = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i;

/** The Rec. 709 weights of red, green and blue in relative luminance. */
const LUMINANCE_WEIGHTS = [0.2126, 0.7152, 0.0722];

/** What marks the generated activity: it is the file that turns edge-to-edge on. */
const EDGE_TO_EDGE_CALL = "enableEdgeToEdge(";

/** The call exactly as `tauri android init` (cli 2.12) writes it. */
const BARE_CALL = "enableEdgeToEdge()";

/**
 * Builds the styled call: both bars get the same style, with a transparent scrim so the
 * page still draws behind them.
 *
 * @param style - The Kotlin `SystemBarStyle` expression for both bars.
 * @returns The `enableEdgeToEdge(...)` call.
 * @example
 * ```ts
 * styledCall("SystemBarStyle.dark(Color.TRANSPARENT)");
 * // "enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))"
 * ```
 */
function styledCall(style: string): string {
  return `enableEdgeToEdge(statusBarStyle = ${style}, navigationBarStyle = ${style})`;
}

/** The call this patch writes per tone: `dark()` draws light icons, `light()` dark ones. */
const STYLED_CALLS: Readonly<Record<SystemBarTone, string>> = {
  dark: styledCall("SystemBarStyle.dark(Color.TRANSPARENT)"),
  light: styledCall("SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)")
};

/** Every call this patch may replace: the generated one and its own two rewrites. */
const KNOWN_CALLS = [BARE_CALL, STYLED_CALLS.dark, STYLED_CALLS.light];

/** The imports the styled call needs, in the order they are added after the last import. */
const STYLE_IMPORTS: readonly StyleImport[] = [
  { line: "import androidx.activity.SystemBarStyle", usage: /\bSystemBarStyle\b/ },
  { line: "import android.graphics.Color", usage: /\bColor\b/ }
];

/** One Kotlin import line, without its line ending. */
const IMPORT_LINE_PATTERN = /^import [^\r\n]*/gm;

/** The carriage return a CRLF line keeps after a split on `\n`. */
const TRAILING_CARRIAGE_RETURN = /\r$/;

/**
 * Builds the `[native]` error for a MainActivity.kt whose edge-to-edge call this patch
 * does not recognise.
 *
 * @param filePath - The MainActivity.kt that was read.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw unknownCallError("/repo/.moku/tauri/src-tauri/gen/android/app/src/main/java/com/acme/demo/MainActivity.kt");
 * ```
 */
function unknownCallError(filePath: string): Error {
  return new Error(
    `[native] The enableEdgeToEdge() call in ${filePath} is not the one tauri android init generates.\n  Re-run the mobile init pass (tauri android init) to restore it, or unset app.backgroundColor.`
  );
}

/**
 * Builds the `[native]` error for a MainActivity.kt with no import line, so the system bar
 * imports have no place to go.
 *
 * @param filePath - The MainActivity.kt that was read.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw noImportLineError("/repo/.moku/tauri/src-tauri/gen/android/app/src/main/java/com/acme/demo/MainActivity.kt");
 * ```
 */
function noImportLineError(filePath: string): Error {
  return new Error(
    `[native] ${filePath} has no import line to add the system bar imports after.\n  Re-run the mobile init pass (tauri android init), or unset app.backgroundColor.`
  );
}

/**
 * Builds the `[native]` error for a gen tree without exactly one MainActivity.kt that calls
 * `enableEdgeToEdge()`.
 *
 * @param javaDirectory - The `app/src/main/java` directory that was searched.
 * @param found - The candidates found, sorted; empty when there were none.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw notOneActivityError("/repo/.moku/tauri/src-tauri/gen/android/app/src/main/java", []);
 * ```
 */
function notOneActivityError(javaDirectory: string, found: readonly string[]): Error {
  if (found.length === 0) {
    return new Error(
      `[native] Could not find the MainActivity.kt that calls enableEdgeToEdge() under ${javaDirectory}.\n  Re-run the mobile init pass (tauri android init), or unset app.backgroundColor.`
    );
  }
  return new Error(
    `[native] Found ${found.length} MainActivity.kt files that call enableEdgeToEdge() under ${javaDirectory}: ${found.join(", ")}.\n  Keep the one tauri android init generated, or re-run the mobile init pass (tauri android init).`
  );
}

/**
 * Linearises one sRGB channel, the transfer curve relative luminance is defined on.
 *
 * @param hexPair - The channel as two hex digits.
 * @returns The linear channel value, 0 to 1.
 * @example
 * ```ts
 * linearChannel("ff"); // 1
 * linearChannel("00"); // 0
 * ```
 */
function linearChannel(hexPair: string): number {
  const encoded = Number.parseInt(hexPair, 16) / 255;
  return encoded <= 0.040_45 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

/**
 * Tells a dark background from a light one by its relative luminance (WCAG), alpha
 * ignored. Below {@link DARK_LUMINANCE_THRESHOLD} the background is dark.
 *
 * @param colour - The `app.backgroundColor` value, `#rrggbb` or `#rrggbbaa`.
 * @returns `"dark"` when the background wants light icons, `"light"` when it wants dark ones.
 * @throws {Error} `[native]` when the value is not a hex colour.
 * @example
 * ```ts
 * backgroundTone("#10161d"); // "dark"
 * backgroundTone("#ffffffff"); // "light"
 * ```
 */
export function backgroundTone(colour: string): SystemBarTone {
  const channels = HEX_CHANNELS_PATTERN.exec(colour)?.slice(1);
  if (!channels) {
    throw new Error(
      `[native] app.backgroundColor "${colour}" is not a valid colour.\n  Use a hex colour such as "#10161d".`
    );
  }

  const luminance = channels.reduce(
    (sum, channel, index) => sum + (LUMINANCE_WEIGHTS[index] ?? 0) * linearChannel(channel),
    0
  );
  return luminance < DARK_LUMINANCE_THRESHOLD ? "dark" : "light";
}

/**
 * Adds the imports the styled call needs, each on its own line after the last import, in
 * the file's own line ending. An import already present is not added again.
 *
 * @param source - The MainActivity.kt content, call already styled.
 * @param filePath - The MainActivity.kt path, named in the error.
 * @returns The content with both imports present.
 * @throws {Error} `[native]` when the file has no import line to add them after.
 * @example
 * ```ts
 * addStyleImports("import android.os.Bundle\n\nclass A", "MainActivity.kt");
 * // "import android.os.Bundle\nimport androidx.activity.SystemBarStyle\nimport android.graphics.Color\n\nclass A"
 * ```
 */
function addStyleImports(source: string, filePath: string): string {
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";

  let result = source;
  for (const styleImport of STYLE_IMPORTS) {
    // Already imported: by an earlier pass, or by the file itself.
    if (result.split(/\r?\n/).includes(styleImport.line)) continue;

    const lastImport = [...result.matchAll(IMPORT_LINE_PATTERN)].at(-1);
    if (!lastImport) throw noImportLineError(filePath);
    const end = lastImport.index + lastImport[0].length;
    result = `${result.slice(0, end)}${lineEnding}${styleImport.line}${result.slice(end)}`;
  }
  return result;
}

/**
 * Removes the style imports nothing uses any more, each with its own line. An import that
 * other code still uses stays, so a file that imported `Color` itself keeps it.
 *
 * @param source - The MainActivity.kt content, call already restored to bare.
 * @returns The content without the unused style imports.
 * @example
 * ```ts
 * removeUnusedStyleImports("import android.os.Bundle\nimport android.graphics.Color\n\nclass A");
 * // "import android.os.Bundle\n\nclass A"
 * ```
 */
function removeUnusedStyleImports(source: string): string {
  let lines = source.split("\n");
  for (const styleImport of STYLE_IMPORTS) {
    const code = lines.filter(line => !line.startsWith("import "));
    if (code.some(line => styleImport.usage.test(line))) continue;

    lines = lines.filter(line => line.replace(TRAILING_CARRIAGE_RETURN, "") !== styleImport.line);
  }
  return lines.join("\n");
}

/**
 * Sets the system bar style of a MainActivity.kt. A tone writes the styled call and adds
 * its imports; no tone restores the bare generated call and drops the imports nothing else
 * uses. Only a call this patch knows is touched: the generated one, or one of its own
 * rewrites.
 *
 * @param source - The MainActivity.kt content.
 * @param tone - The background's tone, or undefined when `app.backgroundColor` is unset.
 * @param filePath - The MainActivity.kt path, named in the error.
 * @returns The content with the style applied.
 * @throws {Error} `[native]` when a tone is set and the call is not one this patch knows.
 * @example
 * ```ts
 * applySystemBarStyle("import androidx.activity.enableEdgeToEdge\n\nenableEdgeToEdge()\n", "dark", "MainActivity.kt");
 * // "import androidx.activity.enableEdgeToEdge\nimport androidx.activity.SystemBarStyle\nimport android.graphics.Color\n\n"
 * //   + "enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))\n"
 * ```
 */
export function applySystemBarStyle(
  source: string,
  tone: SystemBarTone | undefined,
  filePath: string
): string {
  // An unknown call is someone else's code: refuse to style it, and never touch it.
  if (!KNOWN_CALLS.some(call => source.includes(call))) {
    if (tone === undefined) return source;
    throw unknownCallError(filePath);
  }

  // Replace whichever known call is there with the wanted one.
  const wanted = tone === undefined ? BARE_CALL : STYLED_CALLS[tone];
  let result = source;
  for (const call of KNOWN_CALLS) result = result.replaceAll(call, () => wanted);

  // Bring the imports in line with the call.
  return tone === undefined ? removeUnusedStyleImports(result) : addStyleImports(result, filePath);
}

/**
 * Styles the Android system bars from `app.backgroundColor`, through the write-if-changed
 * writer. The target is the one MainActivity.kt below `gen/android/app/src/main/java` that
 * calls `enableEdgeToEdge()`. Without a colour a missing or ambiguous activity is left
 * alone, so an app that never set one keeps building; with one it is an error.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param backgroundColor - `app.backgroundColor`, or undefined when unset.
 * @returns The MainActivity.kt path, patched or unchanged; empty when there was none to touch.
 * @throws {Error} `[native]` when a colour is set and there is not exactly one MainActivity.kt
 *   calling `enableEdgeToEdge()`, or its call is not one this patch knows.
 * @example
 * ```ts
 * // First pass on the generated activity; a second pass lists it under `unchanged`.
 * await patchAndroidSystemBars(".moku/tauri", ".moku/tauri/src-tauri/gen/android", "#10161d");
 * // { patched: [".moku/tauri/src-tauri/gen/android/app/src/main/java/com/acme/demo/MainActivity.kt"], unchanged: [] }
 * ```
 */
export async function patchAndroidSystemBars(
  projectDirectory: string,
  genDirectory: string,
  backgroundColor: string | undefined
): Promise<PatchResult> {
  const tone = backgroundColor === undefined ? undefined : backgroundTone(backgroundColor);

  // Find the generated activity: the one MainActivity.kt that turns edge-to-edge on.
  const activities: { readonly path: string; readonly source: string }[] = [];
  for (const file of await androidMainActivityFiles(genDirectory)) {
    const source = await readFile(file, "utf8");
    if (source.includes(EDGE_TO_EDGE_CALL)) activities.push({ path: file, source });
  }
  const [activity] = activities;
  if (activities.length !== 1 || !activity) {
    if (tone === undefined) return { patched: [], unchanged: [] };
    throw notOneActivityError(
      androidJavaDirectory(genDirectory),
      activities.map(candidate => candidate.path)
    );
  }

  // Style it, writing only when the bytes change.
  const patchedSource = applySystemBarStyle(activity.source, tone, activity.path);
  const action = await writeIfChanged(activity.path, patchedSource, projectDirectory);
  return action === "written"
    ? { patched: [activity.path], unchanged: [] }
    : { patched: [], unchanged: [activity.path] };
}
