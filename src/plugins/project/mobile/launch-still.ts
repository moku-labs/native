/**
 * @file project plugin — the Android launch still patch. With `app.launch` set, the app
 * starts with a translucent window on Android 11+ (so the system shows no splash of its
 * own), draws the game's still picture in its first frame at the game's place, and removes
 * it when the page calls `window.__mokuLaunch.ready()` or after `holdMaxMs`. The patch
 * writes the still as a drawable, a `moku_launch_translucent` bool (false, true from API 30),
 * one theme item that points `android:windowIsTranslucent` at it, a `res/raw` file that keeps
 * the drawable through the release resource shrinker, the generated `MokuLaunch.kt` (see
 * `launch-kotlin.ts`) and two hooks in MainActivity.kt.
 *
 * Every line and file this patch writes carries the marker `moku:native launch still`
 * (the drawable is owned by its name), so a pass first strips its own lines and then writes
 * them again: a second pass is a no-op, other bytes (line endings included) survive, and
 * unsetting `app.launch` restores the generated files and removes the owned ones.
 */
import type { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../../../config";
import type { LaunchRect, PatchResult, ResolvedLaunch } from "../types";
import { writeIfChanged } from "../writer";
import { androidJavaDirectory, androidMainActivityFiles, androidResourceDirectory } from "./files";
import { LAUNCH_MARKER, launchKotlin } from "./launch-kotlin";
import type { ThemeWording } from "./window-background";
import {
  appThemeName,
  themeFiles,
  themeInitError,
  WINDOW_BACKGROUND_MARKER
} from "./window-background";

/**
 * The still's bytes, already checked, and the drawable extension its first bytes call for.
 *
 * @example
 * ```ts
 * const image: LaunchImage = await readLaunchImage("/games/memory-missing/assets/splash/studio.webp");
 * // { bytes: <the file>, extension: "webp" }
 * ```
 */
export type LaunchImage = { readonly bytes: Uint8Array; readonly extension: "png" | "webp" };

/** A width and a height, in the window's own units. */
type Size = { readonly width: number; readonly height: number };

/** The paths a pass collects while it runs, before they become a {@link PatchResult}. */
type ResultLists = { patched: string[]; unchanged: string[] };

/** One file's new content, computed before anything is written. */
type FileEdit = { readonly path: string; readonly content: string };

/** The main activity the hooks go into. */
type LaunchActivity = { readonly path: string; readonly source: string };

/** How long the still waits for `ready()` when `holdMaxMs` is unset. */
const DEFAULT_HOLD_MAX_MS = 8000;

/**
 * The aspect range when `aspect` is unset: the engine renderer's default. The engine always
 * fits its frame into a range, so the whole window would misplace the still outside it.
 */
const DEFAULT_ASPECT = { min: 4 / 3, max: 21 / 9 };

/** The wording of this patch's theme errors. */
const LAUNCH_WORDING: ThemeWording = {
  purpose: "to start without the system splash in",
  field: "app.launch"
};

/** The marker as an XML comment. */
const XML_MARKER = `<!-- ${LAUNCH_MARKER} -->`;

/** The marker as a Kotlin line comment. */
const KOTLIN_MARKER = `// ${LAUNCH_MARKER}`;

/** The line of the generated activity the still attaches after. */
const ON_CREATE_CALL = "super.onCreate(savedInstanceState)";

/** The declaration of the activity's `onCreate`, whose indentation a new member takes. */
const ON_CREATE_DECLARATION = "fun onCreate(";

/** The declaration this patch adds; one already there is someone else's. */
const WEB_VIEW_CREATE_DECLARATION = "fun onWebViewCreate(";

/** The package line of a Kotlin file, the package captured. */
const PACKAGE_PATTERN = /^package\s+([\w.]+)/m;

/** The leading spaces and tabs of a line. */
const INDENT_PATTERN = /^[\t ]*/;

/** One level of XML indentation, for a style with no child line to copy it from. */
const XML_INDENT_STEP = "    ";

/** The theme item of the translucent start. */
const THEME_ITEM = '<item name="android:windowIsTranslucent">@bool/moku_launch_translucent</item>';

/** The generated object's file, beside MainActivity.kt. */
const KOTLIN_FILE = "MokuLaunch.kt";

/** The drawable's resource name; `MokuLaunch.kt` looks it up by it. */
const DRAWABLE_NAME = "moku_launch_still";

/** The drawable directory Android never scales from. */
const DRAWABLE_DIRECTORY = "drawable-nodpi";

/** The extensions the drawable may have; the one not written is removed. */
const DRAWABLE_EXTENSIONS = ["png", "webp"] as const;

/** The bool resource file, in `values` (false) and `values-v30` (true). */
const BOOL_FILE = "moku_launch.xml";

/**
 * The shrinker's keep file, in `res/raw`. `MokuLaunch.kt` looks the drawable up by name at run
 * time, so a release build's resource shrinker sees no reference and strips it; `tools:keep`
 * names it. Owned by the marker, like the bool files.
 */
const KEEP_FILE = "moku_launch_keep.xml";

/** The directory of {@link KEEP_FILE}. */
const RAW_DIRECTORY = "raw";

/** The unqualified resource directory: the day theme and the default bool live there. */
const VALUES_DIRECTORY = "values";

/** Android 11 (API 30) and later, where `Activity.setTranslucent` exists. */
const VALUES_V30_DIRECTORY = "values-v30";

/** The theme file `tauri android init` writes per resource qualifier. */
const THEMES_FILE = "themes.xml";

/** The first four bytes of every PNG file. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/**
 * Builds the `[native]` error for a MainActivity.kt the launch still cannot hook into.
 *
 * @param problem - What is wrong, starting with the file path.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * activityError("/repo/MainActivity.kt has no package line to give MokuLaunch.kt").message;
 * // "[native] /repo/MainActivity.kt has no package line to give MokuLaunch.kt.\n  Re-run the mobile init pass (tauri android init), or unset app.launch."
 * ```
 */
function activityError(problem: string): Error {
  return new Error(
    `[native] ${problem}.\n  Re-run the mobile init pass (tauri android init), or unset app.launch.`
  );
}

/**
 * Builds the `[native]` error for a gen tree without exactly one MainActivity.kt that calls
 * `super.onCreate(savedInstanceState)`.
 *
 * @param javaDirectory - The `app/src/main/java` directory that was searched.
 * @param found - The candidates found, sorted; empty when there were none.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * notOneActivityError("/repo/.moku/tauri/src-tauri/gen/android/app/src/main/java", []).message;
 * // "[native] Could not find the MainActivity.kt that calls super.onCreate(savedInstanceState) under …"
 * ```
 */
function notOneActivityError(javaDirectory: string, found: readonly string[]): Error {
  if (found.length === 0) {
    return activityError(
      `Could not find the MainActivity.kt that calls ${ON_CREATE_CALL} under ${javaDirectory}`
    );
  }
  return new Error(
    `[native] Found ${found.length} MainActivity.kt files that call ${ON_CREATE_CALL} under ${javaDirectory}: ${found.join(", ")}.\n  Keep the one tauri android init generated, or re-run the mobile init pass (tauri android init).`
  );
}

/**
 * Reads the leading spaces and tabs of a line.
 *
 * @param line - The line, or undefined past the end of a file.
 * @returns The indentation, possibly empty.
 * @example
 * ```ts
 * indentOf("    super.onCreate(savedInstanceState)"); // "    "
 * ```
 */
function indentOf(line: string | undefined): string {
  return INDENT_PATTERN.exec(line ?? "")?.[0] ?? "";
}

/**
 * Fills the defaults of `app.launch`: the aspect range (4/3 to 21/9, the engine renderer's
 * default), the orientation (`launch.orientation`, else `app.orientation` when it is
 * `"portrait"` or `"landscape"`, else `"portrait"`), the hold (8000 ms), and the image
 * resolved against the cwd, the rule `app.icon` follows.
 *
 * @param app - The `app` block of the global config.
 * @returns The resolved launch, or undefined when `app.launch` is unset.
 * @example
 * ```ts
 * resolveLaunch({ name: "Demo", identifier: "com.acme.demo", orientation: "landscape", launch })?.orientation; // "landscape"
 * ```
 */
export function resolveLaunch(app: Config["app"]): ResolvedLaunch | undefined {
  const { launch } = app;
  if (launch === undefined) return undefined;

  const appOrientation = app.orientation === "landscape" ? "landscape" : "portrait";
  return {
    image: path.resolve(launch.still.image),
    frame: launch.still.frame,
    rect: launch.still.rect,
    aspect: launch.aspect ?? DEFAULT_ASPECT,
    orientation: launch.orientation ?? appOrientation,
    holdMaxMs: launch.holdMaxMs ?? DEFAULT_HOLD_MAX_MS
  };
}

/**
 * Fits the game frame into a window, the engine's `fitFrame`: the largest centred rectangle
 * whose long side / short side, read in the launch orientation, is inside the aspect range.
 *
 * @param windowSize - The window's size.
 * @param launch - The aspect range and the orientation it is read in.
 * @returns The game frame, in the window's units.
 * @example
 * ```ts
 * launchFrame({ width: 360, height: 1000 }, launch); // { x: 0, y: 80, width: 360, height: 840 } for aspect 4/3…21/9
 * ```
 */
export function launchFrame(
  windowSize: Size,
  launch: Pick<ResolvedLaunch, "aspect" | "orientation">
): LaunchRect {
  const { aspect } = launch;

  // The window's sides in the designed orientation, and the ratio the range allows.
  const portrait = launch.orientation === "portrait";
  const short = portrait ? windowSize.width : windowSize.height;
  const long = portrait ? windowSize.height : windowSize.width;
  const ratio = long / short;
  const wanted = Math.min(Math.max(ratio, aspect.min), aspect.max);

  // Too square: the short side shrinks. Too long: the long side does.
  const frameShort = ratio < wanted ? long / wanted : short;
  const frameLong = ratio > wanted ? short * wanted : long;
  const width = portrait ? frameShort : frameLong;
  const height = portrait ? frameLong : frameShort;
  return {
    x: (windowSize.width - width) / 2,
    y: (windowSize.height - height) / 2,
    width,
    height
  };
}

/**
 * Places the still in a window: its canvas covers the game frame, centred (CSS `cover`),
 * and the picture lies in its rectangle on that canvas. The same maths `MokuLaunch.kt`
 * draws by; this twin is the tested reference.
 *
 * @param windowSize - The window's size.
 * @param launch - The resolved launch.
 * @returns Where the picture lies, in the window's units.
 * @example
 * ```ts
 * stillPlacement({ width: 384, height: 832 }, launch); // { x: 31.125, y: 217.75, width: 325, height: 346.667 } for the A Memory Missing still
 * ```
 */
export function stillPlacement(windowSize: Size, launch: ResolvedLaunch): LaunchRect {
  const frame = launchFrame(windowSize, launch);
  const scale = Math.max(frame.width / launch.frame.width, frame.height / launch.frame.height);
  const originX = frame.x + (frame.width - launch.frame.width * scale) / 2;
  const originY = frame.y + (frame.height - launch.frame.height * scale) / 2;
  return {
    x: originX + launch.rect.x * scale,
    y: originY + launch.rect.y * scale,
    width: launch.rect.width * scale,
    height: launch.rect.height * scale
  };
}

/**
 * Sets or clears the launch hooks of a MainActivity.kt. The patch's own lines are removed
 * first; when enabled, `MokuLaunch.attach(this)` goes after the `super.onCreate` line, and an
 * `onWebViewCreate` member that calls `MokuLaunch.bind` goes before the class's last brace,
 * each line ending in the marker and indented as the file is.
 *
 * @param source - The MainActivity.kt content.
 * @param enabled - Whether `app.launch` is set.
 * @param filePath - The MainActivity.kt path, named in the errors.
 * @returns The content with the hooks applied.
 * @throws {Error} `[native]` when enabled and the file has no `super.onCreate` line, already
 *   overrides `onWebViewCreate`, or has no closing brace on a line of its own.
 * @example
 * ```ts
 * applyLaunchActivity(source, false, "MainActivity.kt"); // the generated file again, every launch line gone
 * ```
 */
export function applyLaunchActivity(source: string, enabled: boolean, filePath: string): string {
  const lines = source.split("\n").filter(line => !line.includes(LAUNCH_MARKER));
  if (!enabled) return lines.join("\n");

  // The line to attach after, no foreign override, and the class's end.
  const callIndex = lines.findIndex(line => line.includes(ON_CREATE_CALL));
  if (callIndex === -1) {
    throw activityError(
      `${filePath} has no ${ON_CREATE_CALL} line to attach the launch still after`
    );
  }
  if (lines.some(line => line.includes(WEB_VIEW_CREATE_DECLARATION))) {
    throw new Error(
      `[native] ${filePath} already overrides onWebViewCreate, so the launch still cannot bind the page.\n  Remove that override, or unset app.launch.`
    );
  }
  const closeIndex = lines.findLastIndex(line => line.trim() === "}");
  if (closeIndex <= callIndex) {
    throw activityError(
      `${filePath} has no closing brace of its class to add onWebViewCreate before`
    );
  }

  // Indented as onCreate and its body are; a CRLF file keeps its `\r` on the new lines.
  const bodyIndent = indentOf(lines[callIndex]);
  const memberIndent = indentOf(
    lines.slice(0, callIndex).findLast(line => line.includes(ON_CREATE_DECLARATION))
  );
  const carriageReturn = source.includes("\r\n") ? "\r" : "";
  /**
   * Marks one new line as this patch's.
   *
   * @param line - The line, indented.
   * @returns The line with the marker and the file's line ending.
   */
  const owned = (line: string) => `${line} ${KOTLIN_MARKER}${carriageReturn}`;
  const member = [
    `${memberIndent}override fun onWebViewCreate(webView: android.webkit.WebView) {`,
    `${bodyIndent}super.onWebViewCreate(webView)`,
    `${bodyIndent}MokuLaunch.bind(this, webView)`,
    `${memberIndent}}`
  ].map(line => owned(line));

  return [
    ...lines.slice(0, callIndex + 1),
    owned(`${bodyIndent}MokuLaunch.attach(this)`),
    ...lines.slice(callIndex + 1, closeIndex),
    ...member,
    ...lines.slice(closeIndex)
  ].join("\n");
}

/**
 * Sets or clears the translucent-start item of one `themes.xml`. The patch's own line is
 * removed first; when enabled, the item goes after the start tag of the named style and
 * after the window background lines there, so that patch's strip-and-reinsert leaves it
 * where it is.
 *
 * @param source - The `themes.xml` content.
 * @param styleName - The app theme, as `android:theme` names it without `@style/`.
 * @param enabled - Whether `app.launch` is set and this file holds the app theme.
 * @param filePath - The `themes.xml` path, named in the error.
 * @returns The content with the item applied.
 * @throws {Error} `[native]` when enabled and the file holds no such style.
 * @example
 * ```ts
 * applyLaunchTheme('<resources>\n    <style name="Theme.app" parent="P">\n    </style>\n</resources>\n', "Theme.app", true, "themes.xml");
 * // the same file with the android:windowIsTranslucent item as the style's first line
 * ```
 */
export function applyLaunchTheme(
  source: string,
  styleName: string,
  enabled: boolean,
  filePath: string
): string {
  const lines = source.split("\n").filter(line => !line.includes(LAUNCH_MARKER));
  if (!enabled) return lines.join("\n");

  const styleIndex = lines.findIndex(line => line.includes(`<style name="${styleName}"`));
  if (styleIndex === -1) {
    throw themeInitError(
      `${filePath} has no <style name="${styleName}"> ${LAUNCH_WORDING.purpose}`,
      LAUNCH_WORDING
    );
  }
  const styleIndent = indentOf(lines[styleIndex]);
  const nextIndent = indentOf(lines[styleIndex + 1]);
  const indent =
    nextIndent.length > styleIndent.length ? nextIndent : styleIndent + XML_INDENT_STEP;

  // After the start tag and the window background lines.
  let insertAt = styleIndex + 1;
  while (lines[insertAt]?.includes(WINDOW_BACKGROUND_MARKER)) insertAt += 1;

  const carriageReturn = source.includes("\r\n") ? "\r" : "";
  const item = `${indent}${THEME_ITEM} ${XML_MARKER}${carriageReturn}`;
  return [...lines.slice(0, insertAt), item, ...lines.slice(insertAt)].join("\n");
}

/**
 * Tells a PNG and a WebP file apart by their first bytes.
 *
 * @param bytes - The file's bytes.
 * @returns The drawable extension, or undefined for anything else.
 * @example
 * ```ts
 * imageExtension(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")); // "webp"
 * ```
 */
function imageExtension(bytes: Buffer): LaunchImage["extension"] | undefined {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "png";
  const webp =
    bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
  return webp ? "webp" : undefined;
}

/**
 * Reads `app.launch.still.image` and checks it is a PNG or a WebP by its first bytes. The
 * Android pass calls it before it writes anything.
 *
 * @param file - The resolved, absolute image path.
 * @returns The bytes and the drawable extension.
 * @throws {Error} `[native]` when the file is missing or is not a PNG or WebP.
 * @example
 * ```ts
 * (await readLaunchImage("/games/memory-missing/assets/splash/studio.webp")).extension; // "webp"
 * ```
 */
export async function readLaunchImage(file: string): Promise<LaunchImage> {
  if (!existsSync(file)) {
    throw new Error(
      `[native] app.launch.still.image was not found at ${file}.\n  Point app.launch.still.image at the still picture, a .png or .webp file.`
    );
  }
  const bytes = await readFile(file);
  const extension = imageExtension(bytes);
  if (extension === undefined) {
    throw new Error(
      `[native] app.launch.still.image ${file} is not a PNG or WebP image by its first bytes.\n  Export the still as PNG or WebP, or point app.launch.still.image at the right file.`
    );
  }
  return { bytes, extension };
}

/**
 * Builds one moku-owned bool resource file.
 *
 * @param translucent - The value of `moku_launch_translucent`.
 * @returns The `moku_launch.xml` content.
 * @example
 * ```ts
 * boolResource(true); // a <resources> file with <bool name="moku_launch_translucent">true</bool>
 * ```
 */
function boolResource(translucent: boolean): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    XML_MARKER,
    "<resources>",
    `    <bool name="moku_launch_translucent">${String(translucent)}</bool>`,
    "</resources>",
    ""
  ].join("\n");
}

/**
 * Builds the resource file that keeps the launch drawable through the resource shrinker.
 *
 * @returns The `moku_launch_keep.xml` content.
 * @example
 * ```ts
 * keepResource(); // a <resources> file with tools:keep="@drawable/moku_launch_still"
 * ```
 */
function keepResource(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    XML_MARKER,
    `<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="@drawable/${DRAWABLE_NAME}" />`,
    ""
  ].join("\n");
}

/**
 * Finds the main activity: the one MainActivity.kt that calls `super.onCreate`. A second
 * MainActivity.kt without that line is legal and left alone.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The activity's path and content.
 * @throws {Error} `[native]` when there is not exactly one.
 */
async function findLaunchActivity(genDirectory: string): Promise<LaunchActivity> {
  const activities: LaunchActivity[] = [];
  for (const file of await androidMainActivityFiles(genDirectory)) {
    const source = await readFile(file, "utf8");
    if (source.includes(ON_CREATE_CALL)) activities.push({ path: file, source });
  }
  const [activity] = activities;
  if (activities.length !== 1 || !activity) {
    throw notOneActivityError(
      androidJavaDirectory(genDirectory),
      activities.map(candidate => candidate.path)
    );
  }
  return activity;
}

/**
 * Computes every `themes.xml` with the launch item set or cleared. The day file must hold
 * the app theme; a qualified one (values-night) gets the item when it does.
 *
 * @param resourceDirectory - The `app/src/main/res` directory.
 * @param styleName - The app theme, or undefined to clear the item everywhere.
 * @returns One edit per theme file, in sorted order.
 * @throws {Error} `[native]` when a style is named and the day file lacks it.
 */
async function themeEdits(resourceDirectory: string, styleName?: string): Promise<FileEdit[]> {
  const dayThemes = path.join(resourceDirectory, VALUES_DIRECTORY, THEMES_FILE);
  const edits: FileEdit[] = [];
  for (const file of await themeFiles(resourceDirectory)) {
    const source = await readFile(file, "utf8");
    const holdsTheme =
      styleName !== undefined &&
      (file === dayThemes || source.includes(`<style name="${styleName}"`));
    edits.push({
      path: file,
      content: applyLaunchTheme(source, styleName ?? "", holdsTheme, file)
    });
  }
  return edits;
}

/**
 * Removes a file and records it as patched; a missing file is nothing to do.
 *
 * @param file - The file to remove.
 * @param result - The lists the path is recorded in.
 * @param ownedOnly - Remove it only when it carries the marker.
 * @returns Resolves once the file is gone or was kept.
 */
async function removeFile(file: string, result: ResultLists, ownedOnly: boolean): Promise<void> {
  if (!existsSync(file)) return;
  const source = ownedOnly ? await readFile(file, "utf8") : LAUNCH_MARKER;
  if (!source.includes(LAUNCH_MARKER)) return;
  await rm(file, { force: true });
  result.patched.push(file);
}

/**
 * The unset pass: strips the marker lines where the files exist and removes the owned files
 * that exist. Never throws on a tree it cannot use, and lists only the files it changed.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The files removed or restored, all under `patched`.
 */
async function removeLaunchStill(
  projectDirectory: string,
  genDirectory: string
): Promise<PatchResult> {
  const result: ResultLists = { patched: [], unchanged: [] };
  const resourceDirectory = androidResourceDirectory(genDirectory);

  // The owned resources: the drawable by its name, the bool files and the keep file by their marker.
  for (const extension of DRAWABLE_EXTENSIONS) {
    const drawable = path.join(
      resourceDirectory,
      DRAWABLE_DIRECTORY,
      `${DRAWABLE_NAME}.${extension}`
    );
    await removeFile(drawable, result, false);
  }
  for (const directory of [VALUES_DIRECTORY, VALUES_V30_DIRECTORY]) {
    await removeFile(path.join(resourceDirectory, directory, BOOL_FILE), result, true);
  }
  await removeFile(path.join(resourceDirectory, RAW_DIRECTORY, KEEP_FILE), result, true);

  // The theme item, the generated object and the activity hooks.
  const edits: FileEdit[] = await themeEdits(resourceDirectory);
  for (const activity of await androidMainActivityFiles(genDirectory)) {
    await removeFile(path.join(path.dirname(activity), KOTLIN_FILE), result, true);
    const source = await readFile(activity, "utf8");
    edits.push({ path: activity, content: applyLaunchActivity(source, false, activity) });
  }
  for (const edit of edits) {
    const action = await writeIfChanged(edit.path, edit.content, projectDirectory);
    if (action === "written") result.patched.push(edit.path);
  }
  return result;
}

/**
 * Computes the MainActivity.kt hooks and `MokuLaunch.kt`, checking everything first.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param launch - The resolved launch.
 * @param backgroundColor - `app.backgroundColor`, or undefined for white.
 * @returns The two Kotlin edits: `MokuLaunch.kt`, then MainActivity.kt.
 * @throws {Error} `[native]` when there is not exactly one activity, it has no package line,
 *   a `MokuLaunch.kt` beside it is not ours, or the hooks cannot go in.
 */
async function kotlinEdits(
  genDirectory: string,
  launch: ResolvedLaunch,
  backgroundColor: string | undefined
): Promise<FileEdit[]> {
  const activity = await findLaunchActivity(genDirectory);
  const packageName = PACKAGE_PATTERN.exec(activity.source)?.[1];
  if (packageName === undefined) {
    throw activityError(`${activity.path} has no package line to give MokuLaunch.kt`);
  }

  // A MokuLaunch.kt without the marker is someone else's: never overwritten.
  const kotlinPath = path.join(path.dirname(activity.path), KOTLIN_FILE);
  const existing = existsSync(kotlinPath) ? await readFile(kotlinPath, "utf8") : LAUNCH_MARKER;
  if (!existing.includes(LAUNCH_MARKER)) {
    throw new Error(
      `[native] ${kotlinPath} exists and was not written by @moku-labs/native.\n  Move it away, or unset app.launch.`
    );
  }

  return [
    { path: kotlinPath, content: launchKotlin({ packageName, launch, backgroundColor }) },
    { path: activity.path, content: applyLaunchActivity(activity.source, true, activity.path) }
  ];
}

/**
 * Holds the game's still from the app's first frame on Android, through the write-if-changed
 * writer: the drawable (the file of the other extension removed), the `values` and
 * `values-v30` bools, the shrinker's keep file in `res/raw`, the theme item in every `themes.xml` that holds the app theme,
 * `MokuLaunch.kt` beside MainActivity.kt, then MainActivity.kt's two hooks. Every check runs
 * before the first write. Without a launch the patch's own lines and files are removed, and a
 * tree it never touched reports nothing.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param launch - The resolved `app.launch`, or undefined when unset.
 * @param backgroundColor - `app.backgroundColor`, the still's background; white when unset.
 * @param image - The image the caller already read and checked; read here when omitted.
 * @returns The files patched or unchanged; on unset, only the files removed or restored.
 * @throws {Error} `[native]` when a launch is set and the image is missing or not a PNG or
 *   WebP, there is not exactly one MainActivity.kt calling `super.onCreate`, it has no
 *   package line or already overrides `onWebViewCreate`, a `MokuLaunch.kt` beside it is not
 *   ours, or the manifest or `res/values/themes.xml` lacks the app theme.
 * @example
 * ```ts
 * // First pass on the generated tree; a second pass lists every file under `unchanged`.
 * await patchAndroidLaunchStill(".moku/tauri", ".moku/tauri/src-tauri/gen/android", launch, "#F4E6CA");
 * // { patched: [".../drawable-nodpi/moku_launch_still.webp", ".../values/moku_launch.xml", ".../values-v30/moku_launch.xml",
 * //             ".../raw/moku_launch_keep.xml", ".../values/themes.xml", ".../values-night/themes.xml", ".../MokuLaunch.kt", ".../MainActivity.kt"], unchanged: [] }
 * ```
 */
export async function patchAndroidLaunchStill(
  projectDirectory: string,
  genDirectory: string,
  launch: ResolvedLaunch | undefined,
  backgroundColor: string | undefined,
  image?: LaunchImage
): Promise<PatchResult> {
  if (launch === undefined) return removeLaunchStill(projectDirectory, genDirectory);

  // Every check before the first write: the image, the activity, the app theme.
  const still = image ?? (await readLaunchImage(launch.image));
  const kotlin = await kotlinEdits(genDirectory, launch, backgroundColor);
  const resourceDirectory = androidResourceDirectory(genDirectory);
  const styleName = await appThemeName(genDirectory, LAUNCH_WORDING);
  const dayThemes = path.join(resourceDirectory, VALUES_DIRECTORY, THEMES_FILE);
  if (!existsSync(dayThemes)) throw themeInitError(`${dayThemes} not found`, LAUNCH_WORDING);
  const themes = await themeEdits(resourceDirectory, styleName);

  const result: ResultLists = { patched: [], unchanged: [] };
  /**
   * Writes one file if its bytes changed, and records it.
   *
   * @param file - The file to write.
   * @param content - Its wanted content.
   * @returns Resolves once the file is current.
   */
  const write = async (file: string, content: string | Uint8Array) => {
    const action = await writeIfChanged(file, content, projectDirectory);
    (action === "written" ? result.patched : result.unchanged).push(file);
  };

  // The drawable, and the one of the other extension gone.
  const drawableDirectory = path.join(resourceDirectory, DRAWABLE_DIRECTORY);
  await write(path.join(drawableDirectory, `${DRAWABLE_NAME}.${still.extension}`), still.bytes);
  for (const extension of DRAWABLE_EXTENSIONS.filter(other => other !== still.extension)) {
    await removeFile(path.join(drawableDirectory, `${DRAWABLE_NAME}.${extension}`), result, false);
  }

  // The translucent start from API 30, then the theme item, the object and the hooks.
  await write(path.join(resourceDirectory, VALUES_DIRECTORY, BOOL_FILE), boolResource(false));
  await write(path.join(resourceDirectory, VALUES_V30_DIRECTORY, BOOL_FILE), boolResource(true));

  // The release shrinker strips a resource no code names statically; the still is named at run
  // time. Like the bool files, a file of that name without the marker is replaced on a set pass.
  await write(path.join(resourceDirectory, RAW_DIRECTORY, KEEP_FILE), keepResource());
  for (const edit of [...themes, ...kotlin]) await write(edit.path, edit.content);
  return result;
}
