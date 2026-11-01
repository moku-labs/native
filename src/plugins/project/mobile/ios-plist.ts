/**
 * @file project plugin — the iOS `Info.plist` patch: takes the debug keys out of a kept tree.
 *
 * `tauri ios build` merges `Info.ios.plist` INTO `gen/apple/<slug>_iOS/Info.plist` for good
 * (measured with tauri-cli 2.11.4), so a key dropped from the sidecar stays in that file: a
 * store build of a tree that once built in debug would ship the loosened App Transport
 * Security. Outside the debug profile this pass removes both debug keys; the sidecar merge
 * after it restores whatever the game itself asked for.
 *
 * The transform is a pure text function over the shape the plist crate writes: line endings
 * and every neighbouring line survive byte for byte, and a file without the keys comes back
 * untouched. That crate escapes every value and writes no comment, so a `<` is always a tag.
 */
import { readFile } from "node:fs/promises";
import { APP_TRANSPORT_SECURITY_KEY, LOCAL_NETWORK_USAGE_KEY } from "../generators/sidecar";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";
import { IOS_INFO_PLIST_FILE, iosInfoPlistFiles } from "./files";
import { missingAnchorError } from "./ios-project";

/** The keys only a debug build may carry, the ones `generators/sidecar.ts` adds there. */
const DEBUG_KEYS = [LOCAL_NETWORK_USAGE_KEY, APP_TRANSPORT_SECURITY_KEY];

/** Every element tag of a plist. Group 1 marks a closing tag, group 2 a self-closed one. */
const TAG_PATTERN = /<(\/?)[a-z][^<>]*?(\/?)>/gi;

/**
 * Finds where the plist value that starts after `from` ends, walking its depth: a `<dict>`
 * may hold more of them, and a `<dict/>` opens nothing.
 *
 * @param text - The file content.
 * @param from - The index right after the value's `<key>` element.
 * @returns The index after the value, or undefined when no value follows.
 * @example
 * ```ts
 * valueEnd("<key>K</key><dict><dict/></dict>", 12); // 32
 * ```
 */
function valueEnd(text: string, from: number): number | undefined {
  // Walk the tags, tracking the nesting, until the value's own element closes.
  let depth = 0;
  for (const match of text.slice(from).matchAll(TAG_PATTERN)) {
    const [tag, closing, selfClosed] = match;
    const nextKeyFirst = depth === 0 && tag === "<key>";
    if (nextKeyFirst) return undefined;

    if (closing) depth -= 1;
    else if (!selfClosed) depth += 1;

    if (depth === 0) return from + match.index + tag.length;
    if (depth < 0) return undefined;
  }
  return undefined;
}

/**
 * Cuts a range out of a text: the whole lines when the range is alone on them, so no blank
 * line stays behind and the file keeps its line endings, otherwise the range only.
 *
 * @param text - The file content.
 * @param start - The index of the range's first character.
 * @param end - The index after its last character.
 * @returns The text without the range.
 * @example
 * ```ts
 * cutRange("a\n\tb\nc\n", 3, 4); // "a\nc\n"
 * ```
 */
function cutRange(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const lineBreak = text.indexOf("\n", end);
  const lineEnd = lineBreak === -1 ? text.length : lineBreak + 1;

  const aloneOnItsLines =
    text.slice(lineStart, start).trim() === "" && text.slice(end, lineEnd).trim() === "";
  return aloneOnItsLines
    ? text.slice(0, lineStart) + text.slice(lineEnd)
    : text.slice(0, start) + text.slice(end);
}

/**
 * Removes keys and their values from the text of an XML property list. A value is whatever
 * element follows the `<key>`, however deep it nests. Content without the keys comes back
 * byte-identical, so the writer leaves the file alone.
 *
 * @param existing - The current `Info.plist` content.
 * @param keys - The keys to remove.
 * @returns The content without those keys.
 * @throws {Error} `[native]` when a key has no value after it: the file is broken, and a store
 *   build must not go on with the key still in it.
 * @example
 * ```ts
 * removePlistKeys("<dict>\n\t<key>A</key>\n\t<dict/>\n\t<key>B</key>\n\t<true/>\n</dict>\n", ["A"]);
 * // "<dict>\n\t<key>B</key>\n\t<true/>\n</dict>\n"
 * ```
 */
export function removePlistKeys(existing: string, keys: readonly string[]): string {
  // Cut every occurrence of each key, a nested one included, until none is left.
  let text = existing;
  for (const key of keys) {
    const element = `<key>${key}</key>`;
    for (let start = text.indexOf(element); start !== -1; start = text.indexOf(element)) {
      const end = valueEnd(text, start + element.length);
      if (end === undefined) throw missingAnchorError(`the value of ${key}`, IOS_INFO_PLIST_FILE);
      text = cutRange(text, start, end);
    }
  }
  return text;
}

/**
 * Takes the debug keys out of the `Info.plist` of a kept iOS tree. Idempotent: a second pass
 * reports the file unchanged. A tree where tauri has not written the file reports nothing.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/apple` directory.
 * @returns The paths patched vs. left unchanged.
 * @throws {Error} `[native]` when a debug key has no value after it.
 * @example
 * ```ts
 * await patchIosInfoPlist(projectDir, path.join(projectDir, "src-tauri/gen/apple"));
 * // { patched: [".../gen/apple/my-game_iOS/Info.plist"], unchanged: [] }
 * ```
 */
export async function patchIosInfoPlist(
  projectDirectory: string,
  genDirectory: string
): Promise<PatchResult> {
  const patched: string[] = [];
  const unchanged: string[] = [];

  // Strip the debug keys from each Info.plist, recording whether the file changed.
  for (const file of await iosInfoPlistFiles(genDirectory)) {
    const content = removePlistKeys(await readFile(file, "utf8"), DEBUG_KEYS);
    const action = await writeIfChanged(file, content, projectDirectory);
    (action === "written" ? patched : unchanged).push(file);
  }
  return { patched, unchanged };
}
