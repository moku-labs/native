/**
 * @file project plugin — the Android manifest patch. Tauri has no config key for what the
 * main activity carries (`android:screenOrientation` among them), so the mobile patch pass
 * sets those attributes on the `<activity>` of the generated
 * `gen/android/app/src/main/AndroidManifest.xml` itself. The same rules set attributes on
 * the `<application>` start tag (the debug profile's network security config).
 *
 * The transform is a pure text function: only the touched attribute changes, every other
 * byte (line endings and indentation included) survives, and a second pass is a no-op.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ManifestEntry, PatchResult } from "../types";
import { writeIfChanged } from "../writer";
import { escapeXml } from "../xml";

/** The manifest entry kinds this patch applies: an attribute on one start tag. */
type AttributeEntry = Extract<
  ManifestEntry,
  { kind: "activity-attribute" | "application-attribute" }
>;

/** One `<activity>` element of the manifest, located by offsets into the file. */
type ActivityTag = {
  /** Offset of the `<` that opens the start tag. */
  readonly start: number;
  /** Offset just past the `>` that closes the start tag. */
  readonly end: number;
  /** Whether the element's body declares the MAIN intent action. */
  readonly isMain: boolean;
};

/** Where `tauri android init` writes the app manifest, below `gen/android`. */
const MANIFEST_PATH_SEGMENTS = ["app", "src", "main", "AndroidManifest.xml"];

/** The tag name the application start tag opens with. */
const APPLICATION_OPEN = "<application";

/** Where an `<application` start tag opens. */
const APPLICATION_OPEN_PATTERN = /<application(?=[\s/>])/;

/** The tag name an activity start tag opens with. */
const ACTIVITY_OPEN = "<activity";

/** The end tag that closes an activity's body. */
const ACTIVITY_CLOSE = "</activity>";

/** The intent action that marks the launcher activity. */
const MAIN_ACTION = "android.intent.action.MAIN";

/** Where an `<activity` start tag opens — `<activity-alias` is a different element. */
const ACTIVITY_OPEN_PATTERN = /<activity(?=[\s/>])/g;

/**
 * One attribute inside a start tag, from the whitespace character before it:
 * ` (name)="value"`. XML allows spaces around `=`, but no generated manifest writes them.
 */
const ATTRIBUTE_PATTERN = /\s([\w:.-]+)=(?:"[^"]*"|'[^']*')/g;

/** An XML comment — blanked before the scan, so a commented-out activity never counts. */
const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

/**
 * Builds the `[native]` error for a manifest whose main activity cannot be told apart.
 *
 * @param manifestPath - The manifest that was searched.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw mainActivityError("/repo/.moku/tauri/src-tauri/gen/android/app/src/main/AndroidManifest.xml");
 * ```
 */
function mainActivityError(manifestPath: string): Error {
  return new Error(
    `[native] Could not find the main <activity> in ${manifestPath}.\n  Re-run the mobile init pass (tauri android init) or report the manifest Tauri generated.`
  );
}

/**
 * Builds the `[native]` error for a manifest without an `<application>` element.
 *
 * @param manifestPath - The manifest that was searched.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw applicationError("/repo/.moku/tauri/src-tauri/gen/android/app/src/main/AndroidManifest.xml");
 * ```
 */
function applicationError(manifestPath: string): Error {
  return new Error(
    `[native] Could not find the <application> element in ${manifestPath}.\n  Re-run the mobile init pass (tauri android init) or report the manifest Tauri generated.`
  );
}

/**
 * Finds where a start tag ends. A quoted attribute value is skipped whole, so a `>` inside
 * one never ends the tag.
 *
 * @param text - The manifest content.
 * @param from - Offset just past the tag name.
 * @returns The offset just past the closing `>`, or undefined for a tag that never closes.
 * @example
 * ```ts
 * startTagEnd('<activity android:label="a > b">', 9); // 32
 * ```
 */
function startTagEnd(text: string, from: number): number | undefined {
  let quote: string | undefined;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    // Inside a quoted value: only the matching quote ends it, a `>` is plain text.
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    // An opening quote starts a value.
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    // Outside any value, the first `>` closes the tag.
    if (character === ">") return index + 1;
  }
  return undefined;
}

/**
 * Locates every `<activity>` start tag and records whether its body declares MAIN.
 * Comments are blanked out first (same length, so every offset still points into the real
 * text), which keeps a commented-out activity from being counted or patched. A start tag
 * that never closes is not counted at all.
 *
 * @param text - The manifest content.
 * @returns One entry per activity, in file order.
 * @example
 * ```ts
 * locateActivities('<activity android:name=".A" /><activity android:name=".B"><action android:name="android.intent.action.MAIN" /></activity>');
 * // [{ start: 0, end: 30, isMain: false }, { start: 30, end: 58, isMain: true }]
 * ```
 */
function locateActivities(text: string): ActivityTag[] {
  const masked = text.replaceAll(COMMENT_PATTERN, comment => " ".repeat(comment.length));

  const activities: ActivityTag[] = [];
  for (const match of masked.matchAll(ACTIVITY_OPEN_PATTERN)) {
    const start = match.index;
    const end = startTagEnd(masked, start + ACTIVITY_OPEN.length);
    if (end === undefined) continue;

    const selfClosing = masked.slice(start, end).endsWith("/>");
    const body = selfClosing ? "" : masked.slice(end, masked.indexOf(ACTIVITY_CLOSE, end));
    activities.push({ start, end, isMain: body.includes(MAIN_ACTION) });
  }
  return activities;
}

/**
 * Picks the main activity: the one whose body declares MAIN. A manifest with a single
 * activity and no MAIN still has an obvious one; anything else is ambiguous.
 *
 * @param activities - Every activity in the manifest.
 * @returns The main activity, or undefined when none or several qualify.
 * @example
 * ```ts
 * mainActivity([{ start: 0, end: 30, isMain: false }, { start: 30, end: 58, isMain: true }]);
 * // { start: 30, end: 58, isMain: true }
 * mainActivity([{ start: 0, end: 30, isMain: false }, { start: 30, end: 58, isMain: false }]); // undefined
 * ```
 */
function mainActivity(activities: readonly ActivityTag[]): ActivityTag | undefined {
  const mains = activities.filter(activity => activity.isMain);
  if (mains.length === 1) return mains[0];
  if (mains.length === 0 && activities.length === 1) return activities[0];
  return undefined;
}

/**
 * Locates the first `<application>` start tag outside a comment.
 *
 * @param text - The manifest content.
 * @returns The tag's offsets, or undefined when there is none.
 * @example
 * ```ts
 * locateApplication('<manifest><application android:label="a"></application></manifest>');
 * // { start: 10, end: 40 }
 * ```
 */
function locateApplication(text: string): { start: number; end: number } | undefined {
  const masked = text.replaceAll(COMMENT_PATTERN, comment => " ".repeat(comment.length));
  const match = APPLICATION_OPEN_PATTERN.exec(masked);
  if (!match) return undefined;
  const end = startTagEnd(masked, match.index + APPLICATION_OPEN.length);
  return end === undefined ? undefined : { start: match.index, end };
}

/**
 * Reads one attribute's value from the `<application>` start tag, as written in the file.
 * Used for resource references (`@xml/…`), which carry no character XML escapes.
 *
 * @param text - The manifest content.
 * @param name - The attribute name, such as `android:networkSecurityConfig`.
 * @returns The value between the quotes, or undefined when the attribute (or `<application>`)
 *   is absent.
 * @example
 * ```ts
 * applicationAttribute('<application android:label="Demo">', "android:label"); // "Demo"
 * ```
 */
export function applicationAttribute(text: string, name: string): string | undefined {
  const application = locateApplication(text);
  if (!application) return undefined;
  const tag = text.slice(application.start, application.end);
  const found = [...tag.matchAll(ATTRIBUTE_PATTERN)].find(match => match[1] === name);
  return found?.[0].slice(found[0].indexOf("=") + 2, -1);
}

/**
 * Applies one attribute entry to a start tag. A value replaces the attribute in place, or
 * is inserted right after the tag name with the whitespace that already follows it — on the
 * template's one-attribute-per-line layout that is the line break plus the next
 * attribute's indentation, CRLF included. An `undefined` value removes the attribute
 * together with the whitespace before it, which on that layout is its whole line.
 *
 * @param tag - The start tag (`<activity …>` or `<application …>`).
 * @param entry - The attribute to set or remove.
 * @param open - The tag name the start tag opens with.
 * @returns The start tag with the entry applied.
 * @example
 * ```ts
 * applyAttribute('<activity android:name=".MainActivity">', portraitEntry, "<activity");
 * // '<activity android:screenOrientation="portrait" android:name=".MainActivity">'
 * ```
 */
function applyAttribute(tag: string, entry: AttributeEntry, open: string): string {
  // Resolve the text to write: `name="value"`, or undefined when the entry removes.
  const rendered =
    entry.value === undefined ? undefined : `${entry.name}="${escapeXml(entry.value)}"`;
  const existing = [...tag.matchAll(ATTRIBUTE_PATTERN)].find(match => match[1] === entry.name);

  // Existing attribute: replace it in place, or remove it with the whitespace before it.
  if (existing) {
    // The whole whitespace run before the attribute: its line break and indent, CRLF included.
    const before = tag.slice(0, existing.index).trimEnd();
    const separator = tag.slice(before.length, existing.index + 1);
    const after = tag.slice(existing.index + existing[0].length);
    if (rendered === undefined) return `${before}${after}`;
    return `${before}${separator}${rendered}${after}`;
  }

  // Absent attribute and a removal: nothing to do.
  if (rendered === undefined) return tag;

  // Absent attribute: insert it right after the tag name, reusing the whitespace that follows.
  const rest = tag.slice(open.length);
  const separator = rest.slice(0, rest.length - rest.trimStart().length) || " ";
  return `${open}${separator}${rendered}${rest}`;
}

/**
 * Applies the `application-attribute` entries to the `<application>` start tag.
 *
 * @param existing - The current manifest content.
 * @param entries - The application attribute entries, in order (a later one wins).
 * @param manifestPath - The manifest's path, named in the error.
 * @returns The manifest with every entry applied.
 * @throws {Error} `[native]` when an attribute is to be set and there is no `<application>`.
 * @example
 * ```ts
 * applyApplicationAttributes("<application>", [{ kind: "application-attribute", name: "android:x", value: "1" }], "AndroidManifest.xml");
 * // '<application android:x="1">'
 * ```
 */
function applyApplicationAttributes(
  existing: string,
  entries: readonly AttributeEntry[],
  manifestPath: string
): string {
  if (entries.length === 0) return existing;

  const application = locateApplication(existing);
  if (!application) {
    if (entries.every(entry => entry.value === undefined)) return existing;
    throw applicationError(manifestPath);
  }

  let tag = existing.slice(application.start, application.end);
  for (const entry of entries) tag = applyAttribute(tag, entry, APPLICATION_OPEN);
  return `${existing.slice(0, application.start)}${tag}${existing.slice(application.end)}`;
}

/**
 * Applies the `application-attribute` entries to the `<application>` start tag and the
 * `activity-attribute` entries to the main activity of a manifest. `child` entries are not
 * applied: no registry row carries one, and the official plugins merge their own manifest
 * needs through build.rs. A pass that only removes attributes leaves a manifest without a
 * clear main activity (or without an `<application>`) as it is.
 *
 * @param existing - The current manifest content.
 * @param entries - The manifest entries to apply, in order (a later one wins).
 * @param manifestPath - The manifest's path, named in the error.
 * @returns The manifest with every attribute entry applied.
 * @throws {Error} `[native]` when an attribute is to be set and the main activity (or the
 *   `<application>` element) cannot be found.
 * @example
 * ```ts
 * applyManifestEntries('<activity android:name=".Main">\n</activity>', orientationManifest("portrait"), "AndroidManifest.xml");
 * // '<activity android:screenOrientation="portrait" android:name=".Main">\n</activity>'
 * ```
 */
export function applyManifestEntries(
  existing: string,
  entries: readonly ManifestEntry[],
  manifestPath: string
): string {
  const withApplication = applyApplicationAttributes(
    existing,
    entries.filter(entry => entry.kind === "application-attribute"),
    manifestPath
  );
  const attributes = entries.filter(entry => entry.kind === "activity-attribute");
  if (attributes.length === 0) return withApplication;

  const activity = mainActivity(locateActivities(withApplication));
  if (!activity) {
    // Removing needs no target: with no clear main activity there is nothing to remove, and
    // an app that never asked for an attribute (an unset orientation) must keep building.
    if (attributes.every(attribute => attribute.value === undefined)) return withApplication;
    throw mainActivityError(manifestPath);
  }

  let tag = withApplication.slice(activity.start, activity.end);
  for (const attribute of attributes) tag = applyAttribute(tag, attribute, ACTIVITY_OPEN);
  return `${withApplication.slice(0, activity.start)}${tag}${withApplication.slice(activity.end)}`;
}

/**
 * Returns the app manifest of a `gen/android` tree.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The `app/src/main/AndroidManifest.xml` path of that tree.
 * @example
 * ```ts
 * androidManifestPath("/repo/.moku/tauri/src-tauri/gen/android");
 * // "/repo/.moku/tauri/src-tauri/gen/android/app/src/main/AndroidManifest.xml"
 * ```
 */
export function androidManifestPath(genDirectory: string): string {
  return path.join(genDirectory, ...MANIFEST_PATH_SEGMENTS);
}

/**
 * Patches `gen/android/app/src/main/AndroidManifest.xml` with the attribute entries (main
 * activity and `<application>`), through the write-if-changed writer. Idempotent: a second
 * pass reports the manifest unchanged. With no attribute entry there is nothing to apply,
 * and the manifest is not even read.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param entries - The manifest entries to apply.
 * @returns The manifest path, patched or unchanged.
 * @throws {Error} `[native]` when the manifest is missing, or an attribute is to be set and
 *   the manifest has no clear main activity.
 * @example
 * ```ts
 * // First pass on a manifest without the lock; a second pass lists it under `unchanged`.
 * await patchAndroidManifest(".moku/tauri", ".moku/tauri/src-tauri/gen/android", orientationManifest("portrait"));
 * // { patched: [".moku/tauri/src-tauri/gen/android/app/src/main/AndroidManifest.xml"], unchanged: [] }
 * ```
 */
export async function patchAndroidManifest(
  projectDirectory: string,
  genDirectory: string,
  entries: readonly ManifestEntry[]
): Promise<PatchResult> {
  if (!entries.some(entry => entry.kind !== "child")) {
    return { patched: [], unchanged: [] };
  }

  const manifestPath = androidManifestPath(genDirectory);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `[native] AndroidManifest.xml not found at ${manifestPath}.\n  Re-run the mobile init pass (tauri android init) before patching the manifest.`
    );
  }

  const existing = await readFile(manifestPath, "utf8");
  const patchedContent = applyManifestEntries(existing, entries, manifestPath);
  const action = await writeIfChanged(manifestPath, patchedContent, projectDirectory);
  return action === "written"
    ? { patched: [manifestPath], unchanged: [] }
    : { patched: [], unchanged: [manifestPath] };
}
