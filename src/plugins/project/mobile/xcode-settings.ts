/**
 * @file project plugin — the Xcode build-settings patch that makes an iOS REBUILD work.
 *
 * A capability plugin's build script rewrites the generated `<app>_iOS.entitlements` file
 * while Xcode is compiling, and Xcode fails the second build on that:
 * `Entitlements file "<app>_iOS.entitlements" was modified during the build, which is not
 * supported`. Xcode names the way out itself — `CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION`
 * — so every `buildSettings` block of the generated `project.pbxproj` carries it, and the
 * `project.yml` target carries it too, so a later xcodegen regeneration keeps it.
 *
 * Both transforms are pure text functions over the real generated shapes: line endings,
 * indentation and every neighbouring line survive byte for byte, and a second pass is a
 * no-op.
 */
import { readFile } from "node:fs/promises";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";
import { iosPatchFiles } from "./files";

/** The Xcode build setting that permits a build script to rewrite the entitlements file. */
export const ENTITLEMENTS_MODIFICATION_KEY = "CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION";

/** The pbxproj value form — Xcode writes booleans as `YES`/`NO`. */
const PBXPROJ_ENABLED_VALUE = "YES";

/**
 * The project.yml value form. xcodegen renders a YAML boolean as `YES` in the pbxproj it
 * generates, which is why the target's sibling settings read `true`/`false` there.
 */
const YML_ENABLED_VALUE = "true";

/** Opens one settings block inside a `XCBuildConfiguration` section. */
const BUILD_SETTINGS_OPEN_PATTERN = /^([ \t]*)buildSettings = \{[ \t]*$/;

/** The setting, already present as a pbxproj assignment (whatever its value). */
const PBXPROJ_SETTING_PATTERN = new RegExp(`^[ \t]*${ENTITLEMENTS_MODIFICATION_KEY}[ \t]*=`);

/** The setting, already present as a YAML key (whatever its value). */
const YML_SETTING_PATTERN = new RegExp(`^[ \t]*${ENTITLEMENTS_MODIFICATION_KEY}[ \t]*:`);

/** Opens a target's `settings:` mapping in `project.yml`. */
const YML_SETTINGS_PATTERN = /^([ \t]*)settings:[ \t]*$/;

/** Opens the `base:` mapping a `settings:` block carries its own build settings in. */
const YML_BASE_PATTERN = /^([ \t]*)base:[ \t]*$/;

/** The leading whitespace of a line — never matches a line break. */
const INDENT_PATTERN = /^[ \t]*/;

/** Splits text into lines, keeping each line's own terminator attached to it. */
const LINE_SPLIT_PATTERN = /(?<=\n)/;

/** A line's terminator (LF or CRLF), stripped to compare the line's text alone. */
const LINE_ENDING_PATTERN = /\r?\n$/;

/** One indentation step inside a pbxproj — the generated file is tab-indented. */
const PBXPROJ_NESTED_INDENT = "\t";

/** One indentation step inside a project.yml — YAML mappings never indent with tabs. */
const YML_NESTED_INDENT = "  ";

/** One source line, split so a rewrite can never change the file's line endings. */
type SourceLine = {
  /** The line's text, without its terminator. */
  readonly body: string;
  /** The line's own terminator — `""` for a final line without one. */
  readonly ending: string;
};

/**
 * Splits text into lines that each remember their own terminator, so a file mixing (or
 * using) CRLF comes back out exactly as it went in.
 *
 * @param text - The file content.
 * @returns One entry per line, in order.
 * @example
 * ```ts
 * splitLines("a\r\nb"); // [{ body: "a", ending: "\r\n" }, { body: "b", ending: "" }]
 * ```
 */
function splitLines(text: string): SourceLine[] {
  return text.split(LINE_SPLIT_PATTERN).map(chunk => {
    const body = chunk.replace(LINE_ENDING_PATTERN, "");
    return { body, ending: chunk.slice(body.length) };
  });
}

/**
 * Joins lines back into file content.
 *
 * @param lines - The lines to join.
 * @returns The file content.
 * @example
 * ```ts
 * joinLines([{ body: "a", ending: "\n" }]); // "a\n"
 * ```
 */
function joinLines(lines: readonly SourceLine[]): string {
  return lines.map(line => line.body + line.ending).join("");
}

/**
 * Reads a line's leading whitespace — the indentation a new sibling line has to match.
 *
 * @param body - The line's text.
 * @returns The leading spaces/tabs, possibly empty.
 * @example
 * ```ts
 * indentOf("\t\t\tisa = XCBuildConfiguration;"); // "\t\t\t"
 * ```
 */
function indentOf(body: string): string {
  return INDENT_PATTERN.exec(body)?.[0] ?? "";
}

/**
 * Returns a block that carries the setting exactly once: an assignment already there is
 * rewritten in place (a block that turned the setting OFF would still break the rebuild),
 * and an absent one is inserted as the block's first entry, at its siblings' indentation.
 *
 * @param block - The lines inside the block, without its opening and closing line.
 * @param options - How to place the setting.
 * @param options.present - Matches an assignment of the setting already in the block.
 * @param options.render - Renders the setting line at a given indentation.
 * @param options.fallbackIndent - Indentation used when the block carries no line to match.
 * @param options.fallbackEnding - Terminator used when the block carries no line to match.
 * @returns The block's lines, with the setting present exactly once.
 * @example
 * ```ts
 * placeSetting(block, { present: PBXPROJ_SETTING_PATTERN, render, fallbackIndent, fallbackEnding });
 * ```
 */
function placeSetting(
  block: readonly SourceLine[],
  options: {
    present: RegExp;
    render: (indent: string) => string;
    fallbackIndent: string;
    fallbackEnding: string;
  }
): SourceLine[] {
  const { present, render, fallbackIndent, fallbackEnding } = options;

  const existingIndex = block.findIndex(line => present.test(line.body));
  if (existingIndex !== -1) {
    return block.map((line, index) =>
      index === existingIndex ? { body: render(indentOf(line.body)), ending: line.ending } : line
    );
  }

  const sibling = block.find(line => line.body.trim().length > 0);
  const indent = sibling ? indentOf(sibling.body) : fallbackIndent;
  return [{ body: render(indent), ending: sibling?.ending ?? fallbackEnding }, ...block];
}

/**
 * Collects the lines of one block, starting at `start` and stopping at the first line the
 * block does not own.
 *
 * @param lines - Every line of the file.
 * @param start - Index of the block's first line.
 * @param isMember - Whether a line still belongs to the block.
 * @returns The block's lines, and the index of the first line after it.
 * @example
 * ```ts
 * const { block, next } = collectBlock(lines, index, line => line.body !== "\t\t\t};");
 * ```
 */
function collectBlock(
  lines: readonly SourceLine[],
  start: number,
  isMember: (line: SourceLine) => boolean
): { block: SourceLine[]; next: number } {
  const block: SourceLine[] = [];

  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || !isMember(line)) break;
    block.push(line);
    index += 1;
  }

  return { block, next: index };
}

/**
 * Renders the setting as a pbxproj assignment.
 *
 * @param indent - The indentation its sibling settings use.
 * @returns The assignment line.
 * @example
 * ```ts
 * renderPbxprojSetting("\t\t\t\t"); // "\t\t\t\tCODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION = YES;"
 * ```
 */
function renderPbxprojSetting(indent: string): string {
  return `${indent}${ENTITLEMENTS_MODIFICATION_KEY} = ${PBXPROJ_ENABLED_VALUE};`;
}

/**
 * Renders the setting as a YAML mapping entry.
 *
 * @param indent - The indentation its sibling entries use.
 * @returns The entry line.
 * @example
 * ```ts
 * renderYmlSetting("        "); // "        CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION: true"
 * ```
 */
function renderYmlSetting(indent: string): string {
  return `${indent}${ENTITLEMENTS_MODIFICATION_KEY}: ${YML_ENABLED_VALUE}`;
}

/**
 * Reads the `base:` mapping a target's `settings:` line opens — the one block in
 * `project.yml` that holds build settings.
 *
 * The block is walked, not peeked at: `base:` is a direct child of `settings:`, but not
 * necessarily the FIRST one — xcodegen is equally happy with `settings:` followed by
 * `groups: [app]` and `base:` below it. So every line indented deeper than `settings:` is
 * scanned until the block dedents, and the first `base:` sitting at the direct-child level
 * wins; a nested `base:` deeper inside somebody else's sub-mapping does not. A `settings:`
 * block carrying no `base:` at all owns no such block and is left alone.
 *
 * @param lines - Every line of the file.
 * @param settingsIndex - Index of the candidate `settings:` line.
 * @returns The `base:` line, its index and its indentation, or undefined when there is none.
 * @example
 * ```ts
 * baseMappingAt(splitLines("    settings:\n      groups: [app]\n      base:\n"), 0);
 * ```
 */
function baseMappingAt(
  lines: readonly SourceLine[],
  settingsIndex: number
): { line: SourceLine; index: number; indent: string } | undefined {
  const settingsLine = lines[settingsIndex];
  const settings = settingsLine && YML_SETTINGS_PATTERN.exec(settingsLine.body);
  if (!settings) return undefined;

  const settingsIndent = (settings[1] ?? "").length;
  let childIndent: number | undefined;

  for (let index = settingsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) break;
    if (line.body.trim().length === 0) continue;

    const indent = indentOf(line.body);
    if (indent.length <= settingsIndent) break;

    childIndent ??= indent.length;
    if (indent.length !== childIndent) continue;
    if (YML_BASE_PATTERN.test(line.body)) return { line, index, indent };
  }

  return undefined;
}

/**
 * Adds `CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION = YES;` to every `buildSettings` block of
 * a generated `project.pbxproj`, exactly once per block and at the indentation its sibling
 * settings use. Content outside those blocks — the shell-script build phase included — is
 * returned byte for byte, and a file that already carries the setting comes back unchanged.
 *
 * @param existing - The current `project.pbxproj` content.
 * @returns The content with the setting in every settings block.
 * @example
 * ```ts
 * applyPbxprojEntitlementsSetting(await readFile(pbxprojPath, "utf8"));
 * ```
 */
export function applyPbxprojEntitlementsSetting(existing: string): string {
  const lines = splitLines(existing);
  const patched: SourceLine[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;
    patched.push(line);
    index += 1;

    const opening = BUILD_SETTINGS_OPEN_PATTERN.exec(line.body);
    if (!opening) continue;

    const blockIndent = opening[1] ?? "";
    const closing = `${blockIndent}};`;
    const { block, next } = collectBlock(lines, index, inner => inner.body !== closing);
    index = next;

    patched.push(
      ...placeSetting(block, {
        present: PBXPROJ_SETTING_PATTERN,
        render: renderPbxprojSetting,
        fallbackIndent: `${blockIndent}${PBXPROJ_NESTED_INDENT}`,
        fallbackEnding: line.ending
      })
    );
  }

  return joinLines(patched);
}

/**
 * Adds the setting to every target's `settings.base` block in a generated `project.yml`, so
 * an xcodegen regeneration writes it back into the pbxproj. Only a `base:` mapping that is a
 * direct child of a `settings:` mapping is touched — a `settingGroups:` block is somebody
 * else's. A blank line inside the block does not end it: YAML mappings end at a dedent, so
 * an entry printed below an empty line is still seen and never duplicated.
 *
 * @param existing - The current `project.yml` content.
 * @returns The content with the setting under each target's `settings.base`.
 * @example
 * ```ts
 * applyProjectYmlEntitlementsSetting(await readFile(projectYmlPath, "utf8"));
 * ```
 */
export function applyProjectYmlEntitlementsSetting(existing: string): string {
  const lines = splitLines(existing);
  const patched: SourceLine[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;

    const base = baseMappingAt(lines, index);
    patched.push(line);
    index += 1;
    if (!base) continue;

    // Everything between the `settings:` line and its `base:` line — `groups: [app]` and
    // friends — is copied through untouched, the `base:` line included.
    patched.push(...lines.slice(index, base.index + 1));
    index = base.index + 1;

    const { block, next } = collectBlock(
      lines,
      index,
      entry => entry.body.trim().length === 0 || indentOf(entry.body).length > base.indent.length
    );
    index = next;

    patched.push(
      ...placeSetting(block, {
        present: YML_SETTING_PATTERN,
        render: renderYmlSetting,
        fallbackIndent: `${base.indent}${YML_NESTED_INDENT}`,
        fallbackEnding: base.line.ending
      })
    );
  }

  return joinLines(patched);
}

/**
 * Applies the entitlements-modification setting to every generated iOS project file —
 * `project.yml` and each `*.xcodeproj/project.pbxproj`. Idempotent: a second pass reports
 * every file unchanged. Nothing under `gen/apple/build` is ever read or written.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/apple` directory.
 * @returns The paths patched vs. left unchanged.
 * @example
 * ```ts
 * await patchXcodeSettings(projectDir, path.join(projectDir, "src-tauri/gen/apple"));
 * ```
 */
export async function patchXcodeSettings(
  projectDirectory: string,
  genDirectory: string
): Promise<PatchResult> {
  const patched: string[] = [];
  const unchanged: string[] = [];

  for (const file of await iosPatchFiles(genDirectory)) {
    const existing = await readFile(file, "utf8");
    const rewritten = file.endsWith(".yml")
      ? applyProjectYmlEntitlementsSetting(existing)
      : applyPbxprojEntitlementsSetting(existing);
    const action = await writeIfChanged(file, rewritten, projectDirectory);
    (action === "written" ? patched : unchanged).push(file);
  }

  return { patched, unchanged };
}
