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
 * The prefixes that introduce a baked-in runner command, most specific first: a YAML
 * `script:` scalar (with the optional sequence dash and indentation), a pbxproj
 * `shellScript = "` assignment, and finally the opening quote of any other source string
 * literal (Kotlin/Gradle). Horizontal whitespace only — `\s` would let a match start on
 * the previous line under the `m` flag.
 */
const RUNNER_PREFIX_ALTERNATIVES = String.raw`[ \t]*(?:-[ \t]+)?script:[ \t]+|.*?shellScript[ \t]*=[ \t]*"|.*?"`;

/**
 * Builds the per-line matcher for one runner verb: `(prefix)(runner)` up to ` <verb>`.
 * Everything Tauri may have detected — `node tauri`, `bun tauri`, `npm run tauri --`,
 * `yarn|pnpm tauri`, `cargo tauri`, or an already-absolute pair — sits in the second
 * group and is what gets replaced.
 *
 * @param verb - The Tauri verb the build phase invokes (a literal, regex-safe string).
 * @returns A global, multiline matcher whose first group is the line's prefix.
 * @example
 * ```ts
 * runnerLinePattern("ios xcode-script");
 * ```
 */
function runnerLinePattern(verb: string): RegExp {
  return new RegExp(`^(${RUNNER_PREFIX_ALTERNATIVES})(.*?)(?= ${verb})`, "gm");
}

/**
 * Rewrites the runner Tauri baked into a generated build phase into an absolute
 * `<node> <tauri.js> <verb>` invocation. The match is runner-agnostic: on every line
 * carrying ` <verb>`, whatever sits between the line's prefix and the verb is replaced.
 *
 * @param existing - The file content to rewrite.
 * @param options - How to rewrite the command.
 * @param options.runner - The absolute Node and `tauri.js` paths.
 * @param options.verb - The Tauri verb the build phase invokes.
 * @param options.quote - The quote form for this file type.
 * @returns The content with every occurrence rewritten (a no-op once already rewritten).
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
  const replacement = `${quote}${runner.nodePath}${quote} ${quote}${runner.tauriJsPath}${quote}`;
  return existing.replaceAll(
    runnerLinePattern(verb),
    (_match, prefix: string) => `${prefix}${replacement}`
  );
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
