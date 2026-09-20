/**
 * @file project plugin — the runner-command rewrite. `tauri ios|android init` bakes
 * whichever runner it DETECTED (`node tauri`, `bun tauri`, `npm run tauri --`, …) into the
 * generated Xcode/Android-Studio build phase, and none of those resolve inside those IDEs —
 * so an unpatched tree fails on its first build phase. Every occurrence becomes the
 * absolute `<node> <tauri.js>` pair the tauri plugin itself spawns with.
 */
import { readFile } from "node:fs/promises";
import type { MobileTarget, TauriRunner } from "../../../config";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";
import { androidPatchFiles, iosPatchFiles } from "./files";

/** `tauri ios init` bakes `<detected-runner> ios xcode-script …` into the Xcode project. */
const IOS_RUNNER_VERB = "ios xcode-script";

/** The Android equivalent, written into buildSrc/gradle sources by `tauri android init`. */
const ANDROID_RUNNER_VERB = "android android-studio-script";

/** A quote inside a pbxproj/Kotlin/Gradle string literal is backslash-escaped. */
const ESCAPED_QUOTE = String.raw`\"`;

/**
 * One quoted shell word, with or without the backslash a source string literal escapes its
 * quotes with — how an already-patched absolute runner path appears in every file we touch.
 */
const QUOTED_RUNNER_WORD = String.raw`\\?"[^"\n]*"`;

/** Horizontal whitespace between two shell words — never a line break. */
const WORD_SEPARATOR = String.raw`[ \t]+`;

/** Anchors the verb lookahead to a whole word, so `ios xcode-scriptX` is not a match. */
const WORD_BOUNDARY = String.raw`\b`;

/** The already-patched form: the `<node> <tauri.js>` pair, each word quoted. */
const ABSOLUTE_RUNNER_PAIR = `${QUOTED_RUNNER_WORD}${WORD_SEPARATOR}${QUOTED_RUNNER_WORD}`;

/** Binaries Tauri may have detected the CLI behind, optionally through an absolute path. */
const RUNNER_BINARIES = "node|bunx|bun|npx|yarn|pnpm|cargo";

/**
 * Every runner shape `tauri ios|android init` bakes in: `<binary> tauri`, npm's
 * `npm run tauri --` form, or a bare `tauri` — each optionally path-qualified. Longest
 * alternative first, so `npm run tauri --` is never truncated to its trailing `tauri`.
 */
const PACKAGE_RUNNER = String.raw`(?:\S*/)?npm run tauri --|(?:\S*/)?(?:${RUNNER_BINARIES}) tauri|(?:\S*/)?tauri`;

/** Characters that would break out of the double-quoted shell word a runner path lands in. */
const SHELL_METACHARACTER_PATTERN = /[\\"$`]/g;

/** A line break inside a runner path would split the generated build phase into two commands. */
const LINE_BREAK_PATTERN = /[\n\r]/;

/** Regex metacharacters, escaped before a caller-supplied verb is embedded in a pattern. */
const REGEX_METACHARACTER_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * Builds the matcher for the runner-shaped token run that sits directly before ` <verb>`.
 * It matches ONLY that run, never the line's prefix: a build phase may carry a preamble
 * (`set -e`, `cd "$SRCROOT" &&`) that has to survive the rewrite untouched.
 *
 * @param verb - The Tauri verb the build phase invokes.
 * @returns A global matcher whose every match is exactly one baked-in runner command.
 * @example
 * ```ts
 * runnerCommandPattern("ios xcode-script");
 * ```
 */
function runnerCommandPattern(verb: string): RegExp {
  const runner = `(?:${ABSOLUTE_RUNNER_PAIR}|${PACKAGE_RUNNER})`;
  return new RegExp(`${runner}(?=${verbSource(verb)})`, "g");
}

/**
 * Builds the matcher for ` <verb>` as its own word — the run every runner command ends at.
 *
 * @param verb - The Tauri verb the build phase invokes.
 * @returns The pattern source, with the verb's regex metacharacters escaped.
 * @example
 * ```ts
 * verbSource("ios xcode-script"); // "[ \\t]+ios\\ xcode\\-script\\b"
 * ```
 */
function verbSource(verb: string): string {
  const escapedVerb = verb.replaceAll(REGEX_METACHARACTER_PATTERN, String.raw`\$&`);
  return `${WORD_SEPARATOR}${escapedVerb}${WORD_BOUNDARY}`;
}

/**
 * Tests whether a file invokes `<verb>` at all — the question that separates "this file has
 * nothing to do with the runner" from "this file's runner is one we do not recognize".
 *
 * @param content - The file content to search.
 * @param verb - The Tauri verb the build phase invokes.
 * @returns Whether the verb appears as its own word after whitespace.
 * @example
 * ```ts
 * mentionsRunnerVerb('script: bun tauri ios xcode-script -v', "ios xcode-script"); // true
 * ```
 */
function mentionsRunnerVerb(content: string, verb: string): boolean {
  return new RegExp(verbSource(verb)).test(content);
}

/**
 * Tests whether a file already carries a runner command this rewrite recognizes.
 *
 * @param content - The file content to search.
 * @param verb - The Tauri verb the build phase invokes.
 * @returns Whether a runner-shaped token run sits directly before the verb.
 * @example
 * ```ts
 * hasRunnerCommand('script: bun tauri ios xcode-script', "ios xcode-script"); // true
 * ```
 */
function hasRunnerCommand(content: string, verb: string): boolean {
  return runnerCommandPattern(verb).test(content);
}

/**
 * Builds the `[native]`-formatted refusal for a build phase whose runner this rewrite does
 * not recognize. Reporting it as "unchanged" would ship a tree that fails on its first
 * Xcode/Android-Studio build phase, with nothing in the log pointing back here.
 *
 * @param verb - The Tauri verb the unrecognized command invokes.
 * @param filePath - The file the command was found in.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw unknownRunnerError("ios xcode-script", "/repo/.moku/tauri/src-tauri/gen/apple/project.yml");
 * ```
 */
function unknownRunnerError(verb: string, filePath: string): Error {
  return new Error(
    `[native] Could not find a Tauri runner command before "${verb}" in ${filePath}.\n  Set pluginConfigs.tauri.nodePath, or report the runner line Tauri generated.`
  );
}

/**
 * Escapes one runner path for the double-quoted shell word it is written into. The path is
 * consumer-influenced (an fnm/nvm prefix, a project checkout), so `"`, `$`, a backtick and a
 * backslash are neutralized rather than trusted.
 *
 * @param value - The absolute path to escape.
 * @returns The escaped path.
 * @throws {Error} `[native]` when the path contains a line break.
 * @example
 * ```ts
 * escapeRunnerPath("/opt/node $HOME/bin/node"); // "/opt/node \\$HOME/bin/node"
 * ```
 */
function escapeRunnerPath(value: string): string {
  if (LINE_BREAK_PATTERN.test(value)) {
    throw new Error(
      `[native] Refusing to write a runner path containing a line break: ${JSON.stringify(value)}.\n  Install Node and the Tauri CLI under a path without line breaks, or set pluginConfigs.tauri.nodePath.`
    );
  }
  return value.replaceAll(SHELL_METACHARACTER_PATTERN, match => `\\${match}`);
}

/**
 * Rewrites the runner Tauri baked into a generated build phase into an absolute
 * `<node> <tauri.js> <verb>` invocation. Only the runner-shaped token run directly before
 * the verb is replaced — anything else on the line (indentation, a `script:` key, a
 * `shellScript = "` assignment, a shell preamble, the verb's own arguments) is preserved
 * byte for byte, and an already-absolute pair is rewritten onto the current one, so a
 * changed Node path (an fnm/nvm switch) re-patches instead of going stale.
 *
 * @param existing - The file content to rewrite.
 * @param options - How to rewrite the command.
 * @param options.runner - The absolute Node and `tauri.js` paths.
 * @param options.verb - The Tauri verb the build phase invokes.
 * @param options.quote - The quote form for this file type.
 * @returns The content with every occurrence rewritten (a no-op once already rewritten).
 * @throws {Error} `[native]` when a runner path contains a line break.
 * @example
 * ```ts
 * applyRunnerCommand(yaml, { runner, verb: "ios xcode-script", quote: '"' });
 * ```
 */
export function applyRunnerCommand(
  existing: string,
  options: { runner: TauriRunner; verb: string; quote: string }
): string {
  const { runner, verb, quote } = options;
  const nodePath = escapeRunnerPath(runner.nodePath);
  const tauriJsPath = escapeRunnerPath(runner.tauriJsPath);
  const replacement = `${quote}${nodePath}${quote} ${quote}${tauriJsPath}${quote}`;
  // A function replacement: a `$` in a path must never be read as a `$&`-style back-reference.
  return existing.replaceAll(runnerCommandPattern(verb), () => replacement);
}

/**
 * Chooses the quote form for a file: a YAML scalar takes real quotes, every other file we
 * patch embeds the command inside a source string literal (pbxproj, Kotlin, Gradle), where
 * the quotes must be backslash-escaped.
 *
 * @param filePath - The file being patched.
 * @returns The quote characters to wrap each runner path in.
 * @example
 * ```ts
 * quoteFor("project.yml"); // '"'
 * ```
 */
function quoteFor(filePath: string): string {
  return filePath.endsWith(".yml") ? '"' : ESCAPED_QUOTE;
}

/**
 * Applies the runner rewrite to every candidate file for a platform, reporting which
 * files actually changed. A second pass rewrites the absolute pair onto itself and
 * reports everything unchanged.
 *
 * A file that invokes the verb but carries a runner shape this rewrite does not recognize
 * is an ERROR, not an "unchanged" file: Tauri baked in a command that will not resolve
 * inside Xcode/Android Studio, and reporting success there means the failure surfaces much
 * later, as an opaque build-phase exit. A file that never mentions the verb is simply
 * unchanged.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The platform's `gen/<platform>` directory.
 * @param opts - The mobile target and the resolved runner pair.
 * @param opts.target - The mobile platform being patched.
 * @param opts.runner - The absolute Node/`tauri.js` pair.
 * @returns The paths patched vs. left unchanged.
 * @throws {Error} `[native]` when a file invokes the verb behind an unrecognized runner.
 * @example
 * ```ts
 * await patchRunner(projectDir, genDir, { target: "ios", runner });
 * ```
 */
export async function patchRunner(
  projectDirectory: string,
  genDirectory: string,
  opts: { target: MobileTarget; runner: TauriRunner }
): Promise<PatchResult> {
  const verb = opts.target === "ios" ? IOS_RUNNER_VERB : ANDROID_RUNNER_VERB;
  const files =
    opts.target === "ios"
      ? await iosPatchFiles(genDirectory)
      : await androidPatchFiles(genDirectory);

  const patched: string[] = [];
  const unchanged: string[] = [];
  for (const file of files) {
    const existing = await readFile(file, "utf8");
    if (mentionsRunnerVerb(existing, verb) && !hasRunnerCommand(existing, verb)) {
      throw unknownRunnerError(verb, file);
    }

    const rewritten = applyRunnerCommand(existing, {
      runner: opts.runner,
      verb,
      quote: quoteFor(file)
    });
    const action = await writeIfChanged(file, rewritten, projectDirectory);
    (action === "written" ? patched : unchanged).push(file);
  }
  return { patched, unchanged };
}
