/**
 * @file project plugin — the iOS project patches: the deployment target and the privacy
 * manifest.
 *
 * `tauri ios build` never runs xcodegen on a kept tree, and init runs before this pass, so a
 * change to `project.yml` alone reaches no build. Every change here lands in `project.yml`
 * (a later xcodegen keeps it) AND in each `project.pbxproj` (the file Xcode reads today).
 *
 * The transforms are pure text functions over the real generated shapes: line endings and
 * every neighbouring line survive byte for byte, and a second pass is a no-op. A file
 * without the line a transform needs is a `[native]` error, never a silent skip: the app
 * would ship the old minimum, or no manifest, with nothing in the log.
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";
import { IOS_PRIVACY_MANIFEST_FILE, iosPatchFiles, iosPrivacyManifestPath } from "./files";
import type { SourceLine } from "./xcode-settings";
import { collectBlock, indentOf, joinLines, splitLines } from "./xcode-settings";

/** The name a pbxproj error reports. */
const PBXPROJ_FILE = "project.pbxproj";

/** The name a project.yml error reports. */
const PROJECT_YML_FILE = "project.yml";

/** Every deployment target of a pbxproj. Group 1 is the line up to the value. */
const PBXPROJ_DEPLOYMENT_PATTERN = /^([ \t]*IPHONEOS_DEPLOYMENT_TARGET = )[^;\r\n]*;/gm;

/** Opens the `deploymentTarget:` mapping of `project.yml`. */
const YML_DEPLOYMENT_PATTERN = /^[ \t]*deploymentTarget:[ \t]*$/;

/** The iOS entry of that mapping. Group 1 is the line up to the value. */
const YML_IOS_ENTRY_PATTERN = /^([ \t]+iOS:[ \t]*)\S.*$/;

/** The object id `mainGroup` names, with or without a name comment after it. */
const MAIN_GROUP_PATTERN = /^[ \t]*mainGroup = (\w+)/;

/** Opens the `children` list of a group. */
const CHILDREN_LINE = "children = (";

/** Opens the `files` list of a build phase. */
const FILES_LINE = "files = (";

/** The `PBXBuildFile` id of the manifest: `MOKU` in ASCII, then a counter. Never xcodegen's. */
const PRIVACY_BUILD_FILE_ID = "4D4F4B5500000000000000A1";

/** The `PBXFileReference` id of the manifest. */
const PRIVACY_FILE_REFERENCE_ID = "4D4F4B5500000000000000A2";

/** The manifest's `PBXBuildFile` line. */
const BUILD_FILE_LINE = `\t\t${PRIVACY_BUILD_FILE_ID} /* ${IOS_PRIVACY_MANIFEST_FILE} in Resources */ = {isa = PBXBuildFile; fileRef = ${PRIVACY_FILE_REFERENCE_ID} /* ${IOS_PRIVACY_MANIFEST_FILE} */; };`;

/** The manifest's `PBXFileReference` line; the root group resolves it from `gen/apple`. */
const FILE_REFERENCE_LINE = `\t\t${PRIVACY_FILE_REFERENCE_ID} /* ${IOS_PRIVACY_MANIFEST_FILE} */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = ${IOS_PRIVACY_MANIFEST_FILE}; sourceTree = "<group>"; };`;

/** The manifest's entry in the root group's `children`. */
const GROUP_CHILD_LINE = `\t\t\t\t${PRIVACY_FILE_REFERENCE_ID} /* ${IOS_PRIVACY_MANIFEST_FILE} */,`;

/** The manifest's entry in the Resources phase's `files`. */
const RESOURCES_FILE_LINE = `\t\t\t\t${PRIVACY_BUILD_FILE_ID} /* ${IOS_PRIVACY_MANIFEST_FILE} in Resources */,`;

/** The `project.yml` key of the targets, top level. */
const YML_TARGETS_LINE = "targets:";

/** Opens a `sources:` list in `project.yml`. */
const YML_SOURCES_PATTERN = /^[ \t]+sources:[ \t]*$/;

/** The first line of a YAML list entry. */
const YML_LIST_ITEM_PATTERN = /^[ \t]*- /;

/** The manifest's entry in the sources list. */
const YML_PRIVACY_PATH_LINE = `- path: ${IOS_PRIVACY_MANIFEST_FILE}`;

/** The second line of that entry. The `assets` entry carries the same one: it stays. */
const YML_RESOURCES_PHASE_LINE = "buildPhase: resources";

/** How deep a list entry's second line sits below its `- `. */
const YML_ENTRY_INDENT = "  ";

/**
 * Builds the `[native]` refusal for a generated file that lacks what a patch needs.
 *
 * @param anchor - What is missing.
 * @param file - The file's name.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * missingAnchorError("mainGroup", "project.pbxproj").message;
 * // "[native] Could not find mainGroup in project.pbxproj.\n  Run clean for ios and build again, or report the project.pbxproj Tauri generated."
 * ```
 */
function missingAnchorError(anchor: string, file: string): Error {
  return new Error(
    `[native] Could not find ${anchor} in ${file}.\n  Run clean for ios and build again, or report the ${file} Tauri generated.`
  );
}

/**
 * Finds a line by its text inside a range of lines.
 *
 * @param lines - Every line of the file.
 * @param matches - Whether a line's text is the one looked for.
 * @param from - Index of the first line to look at.
 * @param to - Index after the last line to look at.
 * @returns The line's index in `lines`, or -1.
 * @example
 * ```ts
 * findLine(splitLines("a\nb\nb\n"), body => body === "b", 2, 3); // 2
 * ```
 */
function findLine(
  lines: readonly SourceLine[],
  matches: (body: string) => boolean,
  from: number,
  to: number
): number {
  const index = lines.slice(from, to).findIndex(line => matches(line.body));
  return index === -1 ? -1 : from + index;
}

/**
 * Finds the `Begin` and `End` comments of a pbxproj section.
 *
 * @param lines - Every line of the file.
 * @param section - The section's name, an `isa` value.
 * @returns The indices of both comments.
 * @throws {Error} `[native]` when the section is not there.
 * @example
 * ```ts
 * sectionBounds(splitLines("/* Begin A section *\/\n/* End A section *\/\n"), "A"); // { begin: 0, end: 1 }
 * ```
 */
function sectionBounds(
  lines: readonly SourceLine[],
  section: string
): { begin: number; end: number } {
  const begin = lines.findIndex(line => line.body === `/* Begin ${section} section */`);
  const end = lines.findIndex(line => line.body === `/* End ${section} section */`);
  if (begin === -1 || end === -1) {
    throw missingAnchorError(`the ${section} section`, PBXPROJ_FILE);
  }
  return { begin, end };
}

/**
 * Finds the `children = (` line of the root group: the group the `PBXProject` object's
 * `mainGroup` names, which has no name of its own to look for.
 *
 * @param lines - Every line of the file.
 * @returns The line's index.
 * @throws {Error} `[native]` when the `mainGroup` line, the group or its list is not there.
 * @example
 * ```ts
 * rootGroupChildren(splitLines(realPbxproj)); // the index of the root group's `children = (`
 * ```
 */
function rootGroupChildren(lines: readonly SourceLine[]): number {
  const project = sectionBounds(lines, "PBXProject");
  const mainGroup = lines
    .slice(project.begin, project.end)
    .map(line => MAIN_GROUP_PATTERN.exec(line.body)?.[1])
    .find(id => id !== undefined);
  if (mainGroup === undefined) throw missingAnchorError("mainGroup", PBXPROJ_FILE);

  const groups = sectionBounds(lines, "PBXGroup");
  const open = findLine(
    lines,
    body => body.trimStart().startsWith(`${mainGroup} `) && body.trimEnd().endsWith("= {"),
    groups.begin,
    groups.end
  );
  const opening = lines[open];
  if (!opening) throw missingAnchorError(`the main group ${mainGroup}`, PBXPROJ_FILE);

  // The block ends at its own `};`: the next group's list is never this group's.
  const closing = `${indentOf(opening.body)}};`;
  const { block } = collectBlock(lines, open, line => line.body !== closing);
  const children = block.findIndex(line => line.body.trim() === CHILDREN_LINE);
  if (children === -1) {
    throw missingAnchorError(`the children of the main group ${mainGroup}`, PBXPROJ_FILE);
  }
  return open + children;
}

/**
 * Finds the `files = (` line of the Resources phase. A generated project has one target,
 * so one such phase.
 *
 * @param lines - Every line of the file.
 * @returns The line's index.
 * @throws {Error} `[native]` when the section or its list is not there.
 * @example
 * ```ts
 * resourcesFiles(splitLines(realPbxproj)); // the index of the Resources phase's `files = (`
 * ```
 */
function resourcesFiles(lines: readonly SourceLine[]): number {
  const phases = sectionBounds(lines, "PBXResourcesBuildPhase");
  const files = findLine(lines, body => body.trim() === FILES_LINE, phases.begin, phases.end);
  if (files === -1) throw missingAnchorError("the PBXResourcesBuildPhase files", PBXPROJ_FILE);
  return files;
}

/**
 * Finds the `iOS:` entry of the `deploymentTarget:` mapping. The mapping is walked to its
 * dedent, so an entry below a sibling or a blank line counts, and an `iOS:` key outside it
 * does not.
 *
 * @param lines - Every line of the file.
 * @returns The entry's index, or -1.
 * @example
 * ```ts
 * ymlDeploymentEntry(splitLines("  deploymentTarget:\n    iOS: 16.0\n")); // 1
 * ```
 */
function ymlDeploymentEntry(lines: readonly SourceLine[]): number {
  const open = lines.findIndex(line => YML_DEPLOYMENT_PATTERN.test(line.body));
  const opening = lines[open];
  if (!opening) return -1;

  const depth = indentOf(opening.body).length;
  const { block } = collectBlock(
    lines,
    open + 1,
    line => line.body.trim().length === 0 || indentOf(line.body).length > depth
  );
  const entry = block.findIndex(line => YML_IOS_ENTRY_PATTERN.test(line.body));
  return entry === -1 ? -1 : open + 1 + entry;
}

/**
 * Rewrites every `IPHONEOS_DEPLOYMENT_TARGET` of a generated `project.pbxproj`, the setting
 * `MinimumOSVersion` comes from.
 *
 * @param existing - The current `project.pbxproj` content.
 * @param version - The deployment target to write.
 * @returns The content with every setting on `version`.
 * @throws {Error} `[native]` when the file has no such line.
 * @example
 * ```ts
 * applyPbxprojDeploymentTarget("\tIPHONEOS_DEPLOYMENT_TARGET = 16.0;\n", "26.0");
 * // "\tIPHONEOS_DEPLOYMENT_TARGET = 26.0;\n"
 * ```
 */
export function applyPbxprojDeploymentTarget(existing: string, version: string): string {
  if (existing.search(PBXPROJ_DEPLOYMENT_PATTERN) === -1) {
    throw missingAnchorError("IPHONEOS_DEPLOYMENT_TARGET", PBXPROJ_FILE);
  }
  return existing.replaceAll(
    PBXPROJ_DEPLOYMENT_PATTERN,
    (_match, assignment: string) => `${assignment}${version};`
  );
}

/**
 * Rewrites `deploymentTarget.iOS` in a generated `project.yml`.
 *
 * @param existing - The current `project.yml` content.
 * @param version - The deployment target to write.
 * @returns The content with the entry on `version`.
 * @throws {Error} `[native]` when the file has no such entry.
 * @example
 * ```ts
 * applyProjectYmlDeploymentTarget("  deploymentTarget:\n    iOS: 16.0\n", "26.0");
 * // "  deploymentTarget:\n    iOS: 26.0\n"
 * ```
 */
export function applyProjectYmlDeploymentTarget(existing: string, version: string): string {
  const lines = splitLines(existing);
  const index = ymlDeploymentEntry(lines);
  const entry = lines[index];
  if (!entry) throw missingAnchorError("deploymentTarget.iOS", PROJECT_YML_FILE);

  const body = entry.body.replace(
    YML_IOS_ENTRY_PATTERN,
    (_match, key: string) => `${key}${version}`
  );
  return joinLines(lines.with(index, { body, ending: entry.ending }));
}

/**
 * Keeps the privacy manifest in a generated `project.pbxproj`: a `PBXBuildFile`, a
 * `PBXFileReference`, a child of the root group and an entry in the Resources phase. Every
 * line carrying one of the two fixed ids is dropped first, so a second pass is a no-op and
 * `enabled: false` gives back the file as it was, needing no anchor.
 *
 * @param existing - The current `project.pbxproj` content.
 * @param enabled - Whether the app carries a manifest.
 * @returns The content with the four lines, or without them.
 * @throws {Error} `[native]` when `enabled` and the file lacks an anchor.
 * @example
 * ```ts
 * applyPbxprojPrivacyManifest("// !$*UTF8*$!\n", false); // "// !$*UTF8*$!\n"
 * ```
 */
export function applyPbxprojPrivacyManifest(existing: string, enabled: boolean): string {
  const lines = splitLines(existing).filter(
    line =>
      !line.body.includes(PRIVACY_BUILD_FILE_ID) && !line.body.includes(PRIVACY_FILE_REFERENCE_ID)
  );
  if (!enabled) return joinLines(lines);

  // Each new line goes before the line at its index, and takes that line's terminator.
  const inserted = new Map([
    [sectionBounds(lines, "PBXBuildFile").end, BUILD_FILE_LINE],
    [sectionBounds(lines, "PBXFileReference").end, FILE_REFERENCE_LINE],
    [rootGroupChildren(lines) + 1, GROUP_CHILD_LINE],
    [resourcesFiles(lines) + 1, RESOURCES_FILE_LINE]
  ]);
  return joinLines(
    lines.flatMap((line, index) => {
      const body = inserted.get(index);
      return body === undefined ? [line] : [{ body, ending: line.ending }, line];
    })
  );
}

/**
 * Tests whether a `project.yml` line is the first line of the manifest's list entry.
 *
 * @param line - The line, or undefined past either end of the file.
 * @returns Whether it is that line.
 * @example
 * ```ts
 * isYmlPrivacyPath({ body: "      - path: PrivacyInfo.xcprivacy", ending: "\n" }); // true
 * ```
 */
function isYmlPrivacyPath(line: SourceLine | undefined): boolean {
  return line?.body.trim() === YML_PRIVACY_PATH_LINE;
}

/**
 * Drops the manifest's list entry from `project.yml`: the path line, and the `buildPhase`
 * line right after it, never the same line of another entry.
 *
 * @param lines - Every line of the file.
 * @returns The lines without the entry.
 * @example
 * ```ts
 * dropYmlPrivacyEntry(splitLines("- path: PrivacyInfo.xcprivacy\n  buildPhase: resources\n")); // []
 * ```
 */
function dropYmlPrivacyEntry(lines: readonly SourceLine[]): SourceLine[] {
  return lines.filter((line, index) => {
    if (isYmlPrivacyPath(line)) return false;
    return !(isYmlPrivacyPath(lines[index - 1]) && line.body.trim() === YML_RESOURCES_PHASE_LINE);
  });
}

/**
 * Finds the first entry of the app target's `sources:` list: the first `sources:` after the
 * top-level `targets:` line. A `targetTemplates` block carries its own one above that line.
 *
 * @param lines - Every line of the file.
 * @returns The first entry's index and line.
 * @throws {Error} `[native]` when there is no such list.
 * @example
 * ```ts
 * firstTargetSource(splitLines("targets:\n  app:\n    sources:\n      - path: Sources\n")).index; // 3
 * ```
 */
function firstTargetSource(lines: readonly SourceLine[]): { index: number; line: SourceLine } {
  const targets = lines.findIndex(line => line.body.trimEnd() === YML_TARGETS_LINE);
  const sources = findLine(
    lines,
    body => YML_SOURCES_PATTERN.test(body),
    targets + 1,
    lines.length
  );
  const index = sources + 1;
  const line = lines[index];
  if (targets === -1 || sources === -1 || !line || !YML_LIST_ITEM_PATTERN.test(line.body)) {
    throw missingAnchorError("the target's sources list", PROJECT_YML_FILE);
  }
  return { index, line };
}

/**
 * Keeps the privacy manifest in a generated `project.yml`, as the first entry of the app
 * target's sources, so a later xcodegen writes it back into the pbxproj. The entry is
 * dropped first, so a second pass is a no-op and `enabled: false` gives back the file as it
 * was, needing no anchor.
 *
 * @param existing - The current `project.yml` content.
 * @param enabled - Whether the app carries a manifest.
 * @returns The content with the entry, or without it.
 * @throws {Error} `[native]` when `enabled` and the file has no target sources list.
 * @example
 * ```ts
 * applyProjectYmlPrivacyManifest("name: app\n", false); // "name: app\n"
 * ```
 */
export function applyProjectYmlPrivacyManifest(existing: string, enabled: boolean): string {
  const lines = dropYmlPrivacyEntry(splitLines(existing));
  if (!enabled) return joinLines(lines);

  const { index, line } = firstTargetSource(lines);
  const indent = indentOf(line.body);
  return joinLines(
    lines.toSpliced(
      index,
      0,
      { body: `${indent}${YML_PRIVACY_PATH_LINE}`, ending: line.ending },
      { body: `${indent}${YML_ENTRY_INDENT}${YML_RESOURCES_PHASE_LINE}`, ending: line.ending }
    )
  );
}

/**
 * Reads the privacy manifest `ios.privacyManifest` names, as bytes: a binary plist is legal.
 * The patch pass calls it first, so a missing source is refused before anything is written.
 *
 * @param source - `ios.privacyManifest`, or undefined when unset.
 * @returns The manifest's bytes, or undefined when the option is unset.
 * @throws {Error} `[native] ios.privacyManifest "<path>" was not found.`
 * @example
 * ```ts
 * await readPrivacyManifest(undefined); // undefined
 * ```
 */
export async function readPrivacyManifest(
  source: string | undefined
): Promise<Uint8Array | undefined> {
  if (source === undefined) return undefined;
  if (!existsSync(source)) {
    throw new Error(
      `[native] ios.privacyManifest "${source}" was not found.\n  Point config.ios.privacyManifest at the manifest file, or unset it.`
    );
  }
  return readFile(source);
}

/**
 * Rewrites every generated iOS project file. All of them are transformed before the first
 * write, so a file that refuses leaves the tree as it was.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/apple` directory.
 * @param transform - Rewrites one file's content; its second argument says whether the file
 *   is `project.yml`.
 * @returns The paths patched vs. left unchanged.
 * @throws {Error} What the transform throws.
 * @example
 * ```ts
 * await rewriteProjectFiles(projectDir, genDir, text => text); // every file unchanged
 * ```
 */
async function rewriteProjectFiles(
  projectDirectory: string,
  genDirectory: string,
  transform: (text: string, isProjectYml: boolean) => string
): Promise<PatchResult> {
  const rewrites: Array<{ file: string; content: string }> = [];
  for (const file of await iosPatchFiles(genDirectory)) {
    const existing = await readFile(file, "utf8");
    rewrites.push({ file, content: transform(existing, file.endsWith(".yml")) });
  }

  const patched: string[] = [];
  const unchanged: string[] = [];
  for (const { file, content } of rewrites) {
    const action = await writeIfChanged(file, content, projectDirectory);
    (action === "written" ? patched : unchanged).push(file);
  }
  return { patched, unchanged };
}

/**
 * Moves a kept iOS tree to the configured deployment target, in `project.yml` and each
 * `project.pbxproj`. Idempotent: a second pass reports every file unchanged.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/apple` directory.
 * @param version - The deployment target to write.
 * @returns The paths patched vs. left unchanged.
 * @throws {Error} `[native]` when a file has no deployment target line.
 * @example
 * ```ts
 * await patchDeploymentTarget(projectDir, path.join(projectDir, "src-tauri/gen/apple"), "26.0");
 * ```
 */
export async function patchDeploymentTarget(
  projectDirectory: string,
  genDirectory: string,
  version: string
): Promise<PatchResult> {
  return rewriteProjectFiles(projectDirectory, genDirectory, (text, isProjectYml) =>
    isProjectYml
      ? applyProjectYmlDeploymentTarget(text, version)
      : applyPbxprojDeploymentTarget(text, version)
  );
}

/**
 * Keeps the privacy manifest of a kept iOS tree: with bytes, `gen/apple/PrivacyInfo.xcprivacy`
 * holds them and `project.yml` and each `project.pbxproj` name it; without, the entries go
 * and so does the file, so the option can be dropped. A tree with no project file gets
 * nothing: no file would name the manifest. Idempotent: a second pass changes nothing.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/apple` directory.
 * @param manifest - The bytes from {@link readPrivacyManifest}, undefined when unset.
 * @returns The paths patched vs. left unchanged; a removed manifest counts as patched.
 * @throws {Error} `[native]` when a manifest meets a project file that lacks an anchor.
 * @example
 * ```ts
 * await patchPrivacyManifest(projectDir, genDir, await readPrivacyManifest("/repo/PrivacyInfo.xcprivacy"));
 * ```
 */
export async function patchPrivacyManifest(
  projectDirectory: string,
  genDirectory: string,
  manifest: Uint8Array | undefined
): Promise<PatchResult> {
  const enabled = manifest !== undefined;
  const { patched, unchanged } = await rewriteProjectFiles(
    projectDirectory,
    genDirectory,
    (text, isProjectYml) =>
      isProjectYml
        ? applyProjectYmlPrivacyManifest(text, enabled)
        : applyPbxprojPrivacyManifest(text, enabled)
  );
  if (patched.length + unchanged.length === 0) return { patched, unchanged };

  const manifestPath = iosPrivacyManifestPath(genDirectory);
  if (manifest !== undefined) {
    const action = await writeIfChanged(manifestPath, manifest, projectDirectory);
    return action === "written"
      ? { patched: [...patched, manifestPath], unchanged }
      : { patched, unchanged: [...unchanged, manifestPath] };
  }

  // Single named file inside gen/apple, never a recursive remove.
  if (!existsSync(manifestPath)) return { patched, unchanged };
  await rm(manifestPath, { force: true });
  return { patched: [...patched, manifestPath], unchanged };
}
