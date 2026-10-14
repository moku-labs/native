/**
 * @file project plugin — the build-profile patches of the Android tree: the Gradle
 * profile block, the debug app name in `strings.xml` and the debug network security config.
 * Each patch is a pure text transform plus a writer, idempotent, and the store profile
 * restores the bytes the tree had before the debug profile touched it. Line endings (CRLF
 * included) follow the file being patched.
 */
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AndroidProfile, ManifestEntry, PatchResult } from "../types";
import { writeIfChanged } from "../writer";
import { androidNetworkConfigPath, androidStringsPath } from "./files";
import { androidManifestPath, applicationAttribute, applyManifestEntries } from "./manifest";

const PROFILE_START = "// MOKU-PROFILE-START";
const PROFILE_END = "// MOKU-PROFILE-END";

/**
 * The comment that opens the debug name lines: `<!-- moku:native debug name <n> <base64> -->`,
 * where `n` is how many renamed lines follow it and the base64 is the original lines.
 */
const DEBUG_NAME_MARKER = "<!-- moku:native debug name";

/** The `strings.xml` elements the debug profile renames: the launcher label and the activity title. */
const NAME_ELEMENT =
  /(<string\s+name="(?:app_name|main_activity_title)"[^>]*>)([\s\S]*?)(<\/string>)/g;

/** The first line of the network security config this plugin writes — its ownership mark. */
const NETWORK_MARKER = "<!-- moku:native debug profile -->";

/** The record of the `<application>` attribute value the debug profile replaced (base64). */
const KEPT_ATTRIBUTE = "<!-- moku:native kept attribute ";

/** The record of the hand-made config file the debug profile replaced (base64 bytes). */
const KEPT_FILE = "<!-- moku:native kept file ";

/** How a record comment closes. */
const RECORD_END = " -->";

/**
 * What the debug config keeps for the next store pass, base64-encoded: the attribute value
 * and the file bytes that were there before the debug profile. `undefined` = there was none.
 */
type KeptNetwork = { readonly attribute: string | undefined; readonly file: string | undefined };

/** The outcome lists one profile pass fills. */
type ResultLists = { patched: string[]; unchanged: string[] };

/** The manifest attribute that points `<application>` at that config. */
const NETWORK_ATTRIBUTE = "android:networkSecurityConfig";

/** The resource the attribute names. */
const NETWORK_RESOURCE = "@xml/network_security_config";

/**
 * Picks the line ending a file already uses, so a patch never mixes them.
 *
 * @param text - The file content.
 * @returns `"\r\n"` when the file has any CRLF, else `"\n"`.
 * @example
 * ```ts
 * lineEnding("a\r\nb\r\n"); // "\r\n"
 * ```
 */
function lineEnding(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Renders the Gradle profile block: the debug app installs beside the store app. The
 * build stays a release build type (optimized Rust and Gradle), so phone measurements match
 * the store app (Decision D1).
 *
 * @param eol - The line ending of the Gradle file.
 * @returns The marker-delimited block, without a trailing line ending.
 * @example
 * ```ts
 * profileBlock("\n").split("\n")[0]; // "// MOKU-PROFILE-START"
 * ```
 */
function profileBlock(eol: string): string {
  return [
    PROFILE_START,
    "android {",
    "  buildTypes {",
    '    getByName("release") {',
    '      applicationIdSuffix = ".debug"',
    "    }",
    "  }",
    "}",
    PROFILE_END
  ].join(eol);
}

/**
 * Applies the profile to `app/build.gradle.kts`. Debug: the block is replaced in place, or
 * appended as `eol + block + eol`. Store: exactly that insertion is cut out again, so the
 * bytes before the debug pass come back — wherever later patches put their own blocks.
 *
 * @param existing - The current Gradle content.
 * @param profile - The build profile.
 * @returns The Gradle content for that profile.
 * @example
 * ```ts
 * applyProfileBlock(applyProfileBlock("plugins {}\n", "debug"), "store"); // "plugins {}\n"
 * ```
 */
export function applyProfileBlock(existing: string, profile: AndroidProfile["profile"]): string {
  const eol = lineEnding(existing);
  const start = existing.indexOf(PROFILE_START);
  const end = existing.indexOf(PROFILE_END, start);
  const present = start !== -1 && end !== -1;

  if (profile === "debug") {
    if (!present) return `${existing}${eol}${profileBlock(eol)}${eol}`;
    return `${existing.slice(0, start)}${profileBlock(eol)}${existing.slice(end + PROFILE_END.length)}`;
  }

  if (!present) return existing;
  const from = existing.slice(start - eol.length, start) === eol ? start - eol.length : start;
  const blockEnd = end + PROFILE_END.length;
  const to = existing.startsWith(eol, blockEnd) ? blockEnd + eol.length : blockEnd;
  return `${existing.slice(0, from)}${existing.slice(to)}`;
}

/**
 * Escapes text for an Android string resource inside an XML element: Android's own escapes
 * first (`\\`, `\'`, `\"`, a leading `@` or `?`), then XML's `&` and `<`. An unescaped
 * apostrophe makes aapt2 refuse the whole resource file.
 *
 * @param text - The raw string.
 * @returns The element body.
 * @example
 * ```ts
 * androidStringResource("Tom's & Co (debug)"); // "Tom\\'s &amp; Co (debug)"
 * ```
 */
export function androidStringResource(text: string): string {
  let escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll("'", String.raw`\'`)
    .replaceAll('"', String.raw`\"`);
  if (escaped.startsWith("@") || escaped.startsWith("?")) escaped = `\\${escaped}`;
  return escaped.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/**
 * Finds where the line holding `index` ends, line ending included.
 *
 * @param text - The file content.
 * @param index - An offset inside the line.
 * @returns The offset just past the line's `\n`, or the text length on the last line.
 * @example
 * ```ts
 * lineEndAfter("a\nb", 0); // 2
 * ```
 */
function lineEndAfter(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline + 1;
}

/**
 * Counts the lines a region spans, its last line counted with or without a line ending.
 *
 * @param region - The text of whole lines.
 * @returns The number of lines.
 * @example
 * ```ts
 * lineCount("a\nb\n"); // 2
 * ```
 */
function lineCount(region: string): number {
  const breaks = region.split("\n").length - 1;
  return region.endsWith("\n") ? breaks : breaks + 1;
}

/**
 * Restores the lines the debug profile renamed: the original lines ride inside the marker
 * comment (base64), after the count of renamed lines that follow it — a multi-line element
 * renamed onto one line spans fewer lines than it did. A file without the marker comes back
 * untouched — it was never debugged.
 *
 * @param existing - The current `strings.xml` content.
 * @returns The content as it was before the debug pass.
 * @example
 * ```ts
 * restoreDebugName(applyDebugName(strings, "My App")) === strings; // true
 * ```
 */
export function restoreDebugName(existing: string): string {
  const marker = existing.indexOf(DEBUG_NAME_MARKER);
  if (marker === -1) return existing;

  const commentEnd = existing.indexOf("-->", marker);
  const [count = "0", payload = ""] = existing
    .slice(marker + DEBUG_NAME_MARKER.length, commentEnd)
    .trim()
    .split(/\s+/);
  const original = Buffer.from(payload, "base64").toString("utf8");

  const lineStart = existing.lastIndexOf("\n", marker) + 1;
  let regionEnd = lineEndAfter(existing, commentEnd);
  for (let line = 0; line < Number.parseInt(count, 10); line += 1) {
    regionEnd = lineEndAfter(existing, regionEnd);
  }
  return `${existing.slice(0, lineStart)}${original}${existing.slice(regionEnd)}`;
}

/**
 * Names the app `"<name> (debug)"` in `strings.xml`: the lines from the first to the last
 * name element get the escaped debug name, and a marker comment before them keeps the
 * original lines for the store profile. A previous debug pass is undone first, so a
 * renamed app is renamed again rather than twice.
 *
 * @param existing - The current `strings.xml` content.
 * @param appName - `app.name`.
 * @returns The content with the debug name, or unchanged without a name element.
 * @example
 * ```ts
 * applyDebugName('<string name="app_name">Demo</string>\n', "Demo").includes("Demo (debug)"); // true
 * ```
 */
export function applyDebugName(existing: string, appName: string): string {
  const base = restoreDebugName(existing);
  const matches = [...base.matchAll(NAME_ELEMENT)];
  const first = matches.at(0);
  const last = matches.at(-1);
  if (!first || !last) return base;

  const regionStart = base.lastIndexOf("\n", first.index) + 1;
  const regionEnd = lineEndAfter(base, last.index + last[0].length);
  const region = base.slice(regionStart, regionEnd);
  const indent = /^[\t ]*/.exec(region)?.[0] ?? "";
  const label = androidStringResource(`${appName} (debug)`);
  const renamed = region.replaceAll(
    NAME_ELEMENT,
    (_element, open: string, _body: string, close: string) => `${open}${label}${close}`
  );
  const payload = Buffer.from(region, "utf8").toString("base64");
  const markerLine = `${indent}${DEBUG_NAME_MARKER} ${lineCount(renamed)} ${payload} -->${lineEnding(base)}`;
  return `${base.slice(0, regionStart)}${markerLine}${renamed}${base.slice(regionEnd)}`;
}

/**
 * Writes `content` and sorts the path into the patched or unchanged list.
 *
 * @param projectDirectory - The Tauri project root (the writer's guard).
 * @param filePath - The file to write.
 * @param content - Its desired content.
 * @param result - The lists to record the outcome in.
 * @param result.patched - Paths written.
 * @param result.unchanged - Paths already carrying `content`.
 * @example
 * ```ts
 * await record(projectDir, gradlePath, next, result);
 * ```
 */
async function record(
  projectDirectory: string,
  filePath: string,
  content: string | Uint8Array,
  result: ResultLists
): Promise<void> {
  const action = await writeIfChanged(filePath, content, projectDirectory);
  (action === "written" ? result.patched : result.unchanged).push(filePath);
}

/**
 * Encodes text for a record comment: base64 never carries the `--` a comment may not hold.
 *
 * @param text - The text to keep, or undefined.
 * @returns The base64 form, or undefined.
 * @example
 * ```ts
 * encode("@xml/loopback"); // "QHhtbC9sb29wYmFjaw=="
 * ```
 */
function encode(text: string | undefined): string | undefined {
  return text === undefined ? undefined : Buffer.from(text, "utf8").toString("base64");
}

/**
 * Reads one record comment of the debug config.
 *
 * @param config - The debug network config.
 * @param prefix - {@link KEPT_ATTRIBUTE} or {@link KEPT_FILE}.
 * @returns The record's base64 payload, or undefined when the config has none.
 * @example
 * ```ts
 * keptRecord("<!-- moku:native kept file PGE+ -->", KEPT_FILE); // "PGE+"
 * ```
 */
function keptRecord(config: string, prefix: string): string | undefined {
  const start = config.indexOf(prefix);
  if (start === -1) return undefined;
  return config.slice(start + prefix.length, config.indexOf(RECORD_END, start));
}

/**
 * Renders the debug network security config: cleartext to every host, so `ws://` reaches
 * the editor over `adb reverse` (127.0.0.1) and on the LAN alike (Decision D4b) — a network
 * security config cannot list IP ranges, and a debug app never ships. The records of what it
 * replaced follow the marker line.
 *
 * @param kept - What the store profile puts back.
 * @returns The config file content.
 * @example
 * ```ts
 * debugNetworkConfig({ attribute: undefined, file: undefined }).split("\n")[0]; // "<!-- moku:native debug profile -->"
 * ```
 */
function debugNetworkConfig(kept: KeptNetwork): string {
  return [
    NETWORK_MARKER,
    ...(kept.attribute === undefined ? [] : [`${KEPT_ATTRIBUTE}${kept.attribute}${RECORD_END}`]),
    ...(kept.file === undefined ? [] : [`${KEPT_FILE}${kept.file}${RECORD_END}`]),
    "<network-security-config>",
    '    <base-config cleartextTrafficPermitted="true" />',
    "</network-security-config>",
    ""
  ].join("\n");
}

/**
 * Sets (a value) or removes (`undefined`) the network config attribute on `<application>`.
 *
 * @param manifest - The manifest content.
 * @param value - The attribute value, or undefined to remove it.
 * @param manifestPath - The manifest's path, named in an error.
 * @returns The manifest with the attribute applied.
 * @example
 * ```ts
 * withNetworkAttribute(manifest, undefined, manifestPath); // the attribute line removed
 * ```
 */
function withNetworkAttribute(
  manifest: string,
  value: string | undefined,
  manifestPath: string
): string {
  const entry: ManifestEntry = { kind: "application-attribute", name: NETWORK_ATTRIBUTE, value };
  return applyManifestEntries(manifest, [entry], manifestPath);
}

/**
 * The debug half of the network config patch: writes the cleartext config and points
 * `<application>` at it. What it replaces — a hand-made config file, a previous attribute
 * value — is kept inside the moku config (or carried over from an earlier debug pass), so the
 * store profile can put it back byte for byte.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param log - Where a replaced hand-made config is reported.
 * @param result - The lists to record the outcome in.
 * @example
 * ```ts
 * await applyDebugNetworkConfig(projectDir, genDir, ctx.log, result);
 * ```
 */
async function applyDebugNetworkConfig(
  projectDirectory: string,
  genDirectory: string,
  log: AndroidProfile["log"],
  result: ResultLists
): Promise<void> {
  const configPath = androidNetworkConfigPath(genDirectory);
  const manifestPath = androidManifestPath(genDirectory);
  const bytes = existsSync(configPath) ? await readFile(configPath) : undefined;
  const config = bytes?.toString("utf8");
  const manifest = existsSync(manifestPath) ? await readFile(manifestPath, "utf8") : undefined;

  let kept: KeptNetwork;
  if (config?.includes(NETWORK_MARKER)) {
    kept = { attribute: keptRecord(config, KEPT_ATTRIBUTE), file: keptRecord(config, KEPT_FILE) };
  } else {
    const attribute =
      manifest === undefined ? undefined : applicationAttribute(manifest, NETWORK_ATTRIBUTE);
    kept = { attribute: encode(attribute), file: bytes?.toString("base64") };
    if (bytes !== undefined) {
      log?.warn("project:patchMobile:foreign-network-config", {
        path: configPath,
        action: "replaced",
        detail: "kept inside the debug config; the next store build writes it back"
      });
    }
  }

  await record(projectDirectory, configPath, debugNetworkConfig(kept), result);
  if (manifest === undefined) return;
  const next = withNetworkAttribute(manifest, NETWORK_RESOURCE, manifestPath);
  await record(projectDirectory, manifestPath, next, result);
}

/**
 * The store half of the network config patch. A moku config is undone from its records: the
 * hand-made file it replaced is written back (or the file deleted when there was none), and
 * the `<application>` attribute gets its old value back (or is removed). A config this plugin
 * did not write is left alone together with the attribute that names it, with a warning
 * (Decision D4). Only what changed is listed.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param log - Where a kept hand-made config is reported.
 * @param result - The lists to record the outcome in.
 * @example
 * ```ts
 * await revertNetworkConfig(projectDir, genDir, ctx.log, result);
 * ```
 */
async function revertNetworkConfig(
  projectDirectory: string,
  genDirectory: string,
  log: AndroidProfile["log"],
  result: ResultLists
): Promise<void> {
  const configPath = androidNetworkConfigPath(genDirectory);
  if (!existsSync(configPath)) return;
  const config = await readFile(configPath, "utf8");
  if (!config.includes(NETWORK_MARKER)) {
    log?.warn("project:patchMobile:foreign-network-config", {
      path: configPath,
      action: "kept",
      detail: "native did not write it, so the store build keeps it and the attribute naming it"
    });
    return;
  }

  const keptFile = keptRecord(config, KEPT_FILE);
  if (keptFile === undefined) {
    await rm(configPath, { force: true });
    result.patched.push(configPath);
  } else {
    await record(projectDirectory, configPath, Buffer.from(keptFile, "base64"), result);
  }

  const manifestPath = androidManifestPath(genDirectory);
  if (!existsSync(manifestPath)) return;
  const manifest = await readFile(manifestPath, "utf8");
  const keptAttribute = keptRecord(config, KEPT_ATTRIBUTE);
  const value =
    keptAttribute === undefined ? undefined : Buffer.from(keptAttribute, "base64").toString("utf8");
  const next = withNetworkAttribute(manifest, value, manifestPath);
  if (next !== manifest) await record(projectDirectory, manifestPath, next, result);
}

/**
 * Applies (debug) or reverts (store) the profile patches under `gen/android`, in this
 * order: the Gradle profile block, the debug app name, the network security config. The
 * debug profile lists every file it owns; the store profile lists only what it reverted, so
 * a tree that was never built in debug reports nothing and is not written.
 *
 * @param options - What to patch.
 * @param options.projectDirectory - The Tauri project root.
 * @param options.genDirectory - Absolute `src-tauri/gen/android` path.
 * @param options.profile - The build profile, with the app name in debug.
 * @returns The paths patched vs. left unchanged.
 * @example
 * ```ts
 * await patchAndroidProfile({ projectDirectory, genDirectory, profile: { profile: "store" } });
 * // { patched: [], unchanged: [] } for a tree never built in debug
 * ```
 */
export async function patchAndroidProfile(options: {
  projectDirectory: string;
  genDirectory: string;
  profile: AndroidProfile;
}): Promise<PatchResult> {
  const { projectDirectory, genDirectory, profile } = options;
  const result: ResultLists = { patched: [], unchanged: [] };

  const gradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  const gradle = await readFile(gradlePath, "utf8");
  const nextGradle = applyProfileBlock(gradle, profile.profile);
  if (profile.profile === "debug" || nextGradle !== gradle) {
    await record(projectDirectory, gradlePath, nextGradle, result);
  }

  const stringsPath = androidStringsPath(genDirectory);
  if (existsSync(stringsPath)) {
    const strings = await readFile(stringsPath, "utf8");
    const nextStrings =
      profile.profile === "debug"
        ? applyDebugName(strings, profile.appName)
        : restoreDebugName(strings);
    if (profile.profile === "debug" || nextStrings !== strings) {
      await record(projectDirectory, stringsPath, nextStrings, result);
    }
  }

  await (profile.profile === "debug"
    ? applyDebugNetworkConfig(projectDirectory, genDirectory, profile.log, result)
    : revertNetworkConfig(projectDirectory, genDirectory, profile.log, result));
  return result;
}
