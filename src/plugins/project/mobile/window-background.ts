/**
 * @file project plugin — the Android window background patch. The generated app theme
 * (`Theme.Material3.DayNight.NoActionBar`) sets no window background, so between the
 * system's icon splash and the WebView's first paint the activity window shows the theme's
 * default, dark in night mode: a dark flash at every launch. When `app.backgroundColor` is
 * set, this patch writes that colour as a moku-owned colour resource and points the app
 * theme's `android:windowBackground` and `android:windowSplashScreenBackground` (the
 * Android 12+ icon splash) at it, in every `res/values*\/themes.xml` that holds the theme.
 *
 * Every line and file this patch writes carries {@link MARKER}, so a pass first strips its
 * own lines and then writes them again: a second pass is a no-op, other bytes (line endings
 * included) survive, and unsetting the colour restores the generated files.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";
import { androidResourceDirectory } from "./files";
import { androidManifestPath, applicationAttribute } from "./manifest";

/** The paths a pass collects while it runs, before they become a {@link PatchResult}. */
type ResultLists = { patched: string[]; unchanged: string[] };

/** Marks every line and file this patch owns. */
const MARKER = "<!-- moku:native window background -->";

/** The colour resource the theme items point at. */
const COLOUR_NAME = "moku_window_background";

/** The unqualified resource directory: the day theme and the colour resource live there. */
const VALUES_DIRECTORY = "values";

/** The theme file `tauri android init` writes per resource qualifier. */
const THEMES_FILE = "themes.xml";

/** `#rrggbb` or `#rrggbbaa`: the colour and the optional alpha, captured apart. */
const HEX_COLOUR_PATTERN = /^#([\da-f]{6})([\da-f]{2})?$/i;

/** The prefix `android:theme` names the app theme with. */
const STYLE_REFERENCE_PREFIX = "@style/";

/** The theme items, in the order they are written: window first, then the icon splash. */
const THEME_ITEMS = [
  `<item name="android:windowBackground">@color/${COLOUR_NAME}</item>`,
  `<item name="android:windowSplashScreenBackground" tools:targetApi="31">@color/${COLOUR_NAME}</item>`
];

/** One level of indentation, for a style with no child line to copy it from. */
const INDENT_STEP = "    ";

/** The leading spaces and tabs of a line. */
const INDENT_PATTERN = /^[\t ]*/;

/**
 * Builds the `[native]` error for a generated file this patch needs and cannot use.
 *
 * @param problem - What is wrong, starting with the file path.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw initError("/repo/.moku/tauri/src-tauri/gen/android/app/src/main/res/values/themes.xml not found");
 * ```
 */
function initError(problem: string): Error {
  return new Error(
    `[native] ${problem}.\n  Re-run the mobile init pass (tauri android init), or unset app.backgroundColor.`
  );
}

/**
 * Converts `app.backgroundColor` to Android's colour notation, which puts the alpha first.
 *
 * @param colour - `#rrggbb` or `#rrggbbaa`.
 * @returns `#rrggbb` unchanged, or `#aarrggbb`.
 * @throws {Error} `[native]` when the value is not a hex colour.
 * @example
 * ```ts
 * androidColour("#10161d"); // "#10161d"
 * androidColour("#10161d80"); // "#8010161d"
 * ```
 */
export function androidColour(colour: string): string {
  const match = HEX_COLOUR_PATTERN.exec(colour);
  if (!match) {
    throw new Error(
      `[native] app.backgroundColor "${colour}" is not a valid colour.\n  Use a hex colour such as "#10161d".`
    );
  }
  const [, rgb = "", alpha = ""] = match;
  return `#${alpha}${rgb}`;
}

/**
 * Sets or clears the window background items of one `themes.xml`. The patch's own lines are
 * removed first; when enabled, the items go right after the start tag of the named style,
 * at the indentation of the line that follows it.
 *
 * @param source - The `themes.xml` content.
 * @param styleName - The app theme, as `android:theme` names it without `@style/`.
 * @param enabled - Whether `app.backgroundColor` is set.
 * @param filePath - The `themes.xml` path, named in the error.
 * @returns The content with the items applied.
 * @throws {Error} `[native]` when enabled and the file holds no such style.
 * @example
 * ```ts
 * applyWindowBackground('<resources>\n    <style name="Theme.app" parent="P">\n    </style>\n</resources>\n', "Theme.app", true, "themes.xml");
 * // the same file with the window and splash items as the style's first two lines
 * ```
 */
export function applyWindowBackground(
  source: string,
  styleName: string,
  enabled: boolean,
  filePath: string
): string {
  const lines = source.split("\n").filter(line => !line.includes(MARKER));
  if (!enabled) return lines.join("\n");

  // The line that opens the app theme, and the one after it for the indentation.
  const index = lines.findIndex(line => line.includes(`<style name="${styleName}"`));
  if (index === -1) {
    throw initError(
      `${filePath} has no <style name="${styleName}"> to set the window background in`
    );
  }
  const styleIndent = INDENT_PATTERN.exec(lines[index] ?? "")?.[0] ?? "";
  const nextIndent = INDENT_PATTERN.exec(lines[index + 1] ?? "")?.[0] ?? "";
  const indent = nextIndent.length > styleIndent.length ? nextIndent : styleIndent + INDENT_STEP;

  // A CRLF file keeps its `\r` on every line, the new ones included.
  const carriageReturn = source.includes("\r\n") ? "\r" : "";
  const items = THEME_ITEMS.map(item => `${indent}${item} ${MARKER}${carriageReturn}`);
  return [...lines.slice(0, index + 1), ...items, ...lines.slice(index + 1)].join("\n");
}

/**
 * Builds the moku-owned colour resource file.
 *
 * @param colour - The colour in Android notation.
 * @returns The `moku_window_background.xml` content.
 * @example
 * ```ts
 * colourResource("#10161d"); // a <resources> file with <color name="moku_window_background">#10161d</color>
 * ```
 */
function colourResource(colour: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    MARKER,
    "<resources>",
    `    <color name="${COLOUR_NAME}">${colour}</color>`,
    "</resources>",
    ""
  ].join("\n");
}

/**
 * Lists every `res/values*\/themes.xml` of the tree, sorted, so `values` comes first.
 *
 * @param resourceDirectory - The `app/src/main/res` directory.
 * @returns The theme files found, possibly none.
 */
async function themeFiles(resourceDirectory: string): Promise<string[]> {
  if (!existsSync(resourceDirectory)) return [];
  const entries = await readdir(resourceDirectory, { withFileTypes: true });
  // Sorted by directory name: as full paths `values-night/` would sort before `values/`.
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(VALUES_DIRECTORY))
    .map(entry => entry.name)
    .toSorted()
    .map(name => path.join(resourceDirectory, name, THEMES_FILE))
    .filter(file => existsSync(file));
}

/**
 * Reads the app theme's style name from the manifest's `<application android:theme>`.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The style name without `@style/`.
 * @throws {Error} `[native]` when the manifest is missing or names no style.
 */
async function appThemeName(genDirectory: string): Promise<string> {
  const manifestPath = androidManifestPath(genDirectory);
  if (!existsSync(manifestPath)) throw initError(`${manifestPath} not found`);

  const theme = applicationAttribute(await readFile(manifestPath, "utf8"), "android:theme");
  if (!theme?.startsWith(STYLE_REFERENCE_PREFIX)) {
    throw initError(
      `${manifestPath} names no android:theme on <application> to set the window background in`
    );
  }
  return theme.slice(STYLE_REFERENCE_PREFIX.length);
}

/**
 * Writes or removes the moku-owned colour resource. A file without the marker is someone
 * else's and is never touched.
 *
 * @param projectDirectory - The Tauri project root.
 * @param colourPath - The `res/values/moku_window_background.xml` path.
 * @param colour - The colour in Android notation, or undefined to remove the file.
 * @param result - The lists the path is recorded in.
 * @returns Resolves once the file is in place or gone.
 */
async function syncColourFile(
  projectDirectory: string,
  colourPath: string,
  colour: string | undefined,
  result: ResultLists
): Promise<void> {
  if (colour !== undefined) {
    const action = await writeIfChanged(colourPath, colourResource(colour), projectDirectory);
    (action === "written" ? result.patched : result.unchanged).push(colourPath);
    return;
  }

  // Unset: remove only a file this patch wrote.
  if (!existsSync(colourPath)) return;
  const existing = await readFile(colourPath, "utf8");
  if (!existing.includes(MARKER)) return;
  await rm(colourPath, { force: true });
  result.patched.push(colourPath);
}

/**
 * Sets the Android window and icon-splash background from `app.backgroundColor`, through
 * the write-if-changed writer: the colour resource, then every `themes.xml` in sorted order.
 * Without a colour the patch's own lines and file are removed, and a tree it never touched
 * is left as it is.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param backgroundColor - `app.backgroundColor`, or undefined when unset.
 * @returns The colour file and theme files, patched or unchanged.
 * @throws {Error} `[native]` when a colour is set and the manifest names no app theme, the
 *   `res/values/themes.xml` is missing, or it lacks the app theme.
 * @example
 * ```ts
 * // First pass on the generated tree; a second pass lists every file under `unchanged`.
 * await patchAndroidWindowBackground(".moku/tauri", ".moku/tauri/src-tauri/gen/android", "#10161d");
 * // { patched: [".../values/moku_window_background.xml", ".../values/themes.xml", ".../values-night/themes.xml"], unchanged: [] }
 * ```
 */
export async function patchAndroidWindowBackground(
  projectDirectory: string,
  genDirectory: string,
  backgroundColor: string | undefined
): Promise<PatchResult> {
  const colour = backgroundColor === undefined ? undefined : androidColour(backgroundColor);
  const resourceDirectory = androidResourceDirectory(genDirectory);
  const dayThemes = path.join(resourceDirectory, VALUES_DIRECTORY, THEMES_FILE);

  // A colour needs the app theme and the day theme file before anything is written.
  const styleName = colour === undefined ? "" : await appThemeName(genDirectory);
  if (colour !== undefined && !existsSync(dayThemes)) throw initError(`${dayThemes} not found`);

  const result: ResultLists = { patched: [], unchanged: [] };
  const colourPath = path.join(resourceDirectory, VALUES_DIRECTORY, `${COLOUR_NAME}.xml`);
  await syncColourFile(projectDirectory, colourPath, colour, result);

  // The day file must hold the app theme; a qualified one (values-night) gets it when it does.
  for (const file of await themeFiles(resourceDirectory)) {
    const source = await readFile(file, "utf8");
    const holdsTheme = file === dayThemes || source.includes(`<style name="${styleName}"`);
    const enabled = colour !== undefined && holdsTheme;
    const patched = applyWindowBackground(source, styleName, enabled, file);
    const action = await writeIfChanged(file, patched, projectDirectory);
    (action === "written" ? result.patched : result.unchanged).push(file);
  }
  return result;
}
