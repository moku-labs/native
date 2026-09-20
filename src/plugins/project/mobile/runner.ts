/**
 * @file project plugin — the runner-command rewrite. `tauri ios|android init` bakes
 * whichever runner it DETECTED (`node tauri`, `bun tauri`, `npm run tauri --`, …) into the
 * generated Xcode/Android-Studio build phase, and none of those resolve inside those IDEs —
 * so an unpatched tree fails on its first build phase. Every occurrence becomes the
 * absolute `<node> <tauri.js>` pair the tauri plugin itself spawns with.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MobileTarget, TauriRunner } from "../../../config";
import type { PatchResult } from "../types";
import { writeIfChanged } from "../writer";

/** `tauri ios init` bakes `<detected-runner> ios xcode-script …` into the Xcode project. */
const IOS_RUNNER_VERB = "ios xcode-script";

/** The Android equivalent, written into buildSrc/gradle sources by `tauri android init`. */
const ANDROID_RUNNER_VERB = "android android-studio-script";

/** Source extensions that can carry the Android runner command. */
const ANDROID_RUNNER_EXTENSIONS = new Set([".kt", ".kts", ".gradle"]);

/** A quote inside a pbxproj/Kotlin/Gradle string literal is backslash-escaped. */
const ESCAPED_QUOTE = String.raw`\"`;

/** Derived directories a runner-command scan never descends into. */
const SKIPPED_DIRECTORIES = new Set(["build", ".gradle", ".idea"]);

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
  const escapedVerb = verb.replaceAll(REGEX_METACHARACTER_PATTERN, String.raw`\$&`);
  const runner = `(?:${ABSOLUTE_RUNNER_PAIR}|${PACKAGE_RUNNER})`;
  const verbAhead = `(?=${WORD_SEPARATOR}${escapedVerb}${WORD_BOUNDARY})`;
  return new RegExp(`${runner}${verbAhead}`, "g");
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
 * Lists the iOS files that carry the runner command: `project.yml` plus the
 * `project.pbxproj` of every generated Xcode project.
 *
 * @param genDirectory - The `src-tauri/gen/apple` directory.
 * @returns The existing files to patch.
 * @example
 * ```ts
 * await iosRunnerFiles("/repo/.moku/tauri/src-tauri/gen/apple");
 * ```
 */
async function iosRunnerFiles(genDirectory: string): Promise<string[]> {
  const files: string[] = [];

  const projectYml = path.join(genDirectory, "project.yml");
  if (existsSync(projectYml)) files.push(projectYml);

  for (const entry of await readdir(genDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".xcodeproj")) continue;
    const pbxproj = path.join(genDirectory, entry.name, "project.pbxproj");
    if (existsSync(pbxproj)) files.push(pbxproj);
  }

  return files;
}

/**
 * Walks a directory tree collecting accepted files, skipping derived build output.
 *
 * @param directory - The directory to walk (a missing directory yields nothing).
 * @param accept - Predicate over the file name.
 * @returns Every accepted file path below `directory`.
 * @example
 * ```ts
 * await collectFiles(buildSrcDirectory, name => name.endsWith(".kt"));
 * ```
 */
async function collectFiles(
  directory: string,
  accept: (name: string) => boolean
): Promise<string[]> {
  if (!existsSync(directory)) return [];

  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await collectFiles(full, accept)));
      continue;
    }
    if (accept(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Lists the Android files that can carry the runner command: every Kotlin/Gradle source
 * under `buildSrc`, plus the two top-level Gradle build files.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The existing files to patch.
 * @example
 * ```ts
 * await androidRunnerFiles("/repo/.moku/tauri/src-tauri/gen/android");
 * ```
 */
async function androidRunnerFiles(genDirectory: string): Promise<string[]> {
  const buildSource = await collectFiles(path.join(genDirectory, "buildSrc"), name =>
    ANDROID_RUNNER_EXTENSIONS.has(path.extname(name))
  );
  const gradleFiles = [
    path.join(genDirectory, "build.gradle.kts"),
    path.join(genDirectory, "app", "build.gradle.kts")
  ].filter(file => existsSync(file));

  return [...buildSource, ...gradleFiles];
}

/**
 * Applies the runner rewrite to every candidate file for a platform, reporting which
 * files actually changed. A second pass rewrites the absolute pair onto itself and
 * reports everything unchanged.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The platform's `gen/<platform>` directory.
 * @param opts - The mobile target and the resolved runner pair.
 * @param opts.target - The mobile platform being patched.
 * @param opts.runner - The absolute Node/`tauri.js` pair.
 * @returns The paths patched vs. left unchanged.
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
      ? await iosRunnerFiles(genDirectory)
      : await androidRunnerFiles(genDirectory);

  const patched: string[] = [];
  const unchanged: string[] = [];
  for (const file of files) {
    const existing = await readFile(file, "utf8");
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
