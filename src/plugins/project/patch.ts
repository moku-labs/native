/**
 * @file project plugin — post-init mobile patch pass: Android release signing, plus the
 * Xcode/Android-Studio runner command Tauri writes but never makes runnable.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { SigningConfig, TauriRunner } from "../../config";
import type { PatchMobileOptions, PatchResult } from "./types";
import { writeIfChanged } from "./writer";

const SIGNING_START = "// MOKU-SIGNING-START";
const SIGNING_END = "// MOKU-SIGNING-END";

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
 * Renders the moku-managed Gradle signing block. Passwords are read by Gradle itself from
 * the environment at build time — only env-var NAMES are ever written to disk, per the
 * `SigningConfig` invariant. `keyPasswordEnv` falls back to `keystorePasswordEnv`, which
 * is the common single-password keystore.
 *
 * @param signing - The Android signing config slice, with a keystore path already present.
 * @param keystorePath - The configured keystore path.
 * @returns The sentinel-delimited Gradle block.
 * @example
 * ```ts
 * renderSigningBlock({ keyAlias: "release" }, "release.jks");
 * ```
 */
function renderSigningBlock(
  signing: NonNullable<SigningConfig["android"]>,
  keystorePath: string
): string {
  const storePasswordEnvironment = signing.keystorePasswordEnv ?? "";
  const keyPasswordEnvironment = signing.keyPasswordEnv ?? storePasswordEnvironment;

  return [
    SIGNING_START,
    "android {",
    "  signingConfigs {",
    '    maybeCreate("release").apply {',
    `      storeFile = file("${keystorePath}")`,
    `      keyAlias = "${signing.keyAlias ?? ""}"`,
    `      storePassword = System.getenv("${storePasswordEnvironment}")`,
    `      keyPassword = System.getenv("${keyPasswordEnvironment}")`,
    "    }",
    "  }",
    "  buildTypes {",
    '    getByName("release") {',
    '      signingConfig = signingConfigs.getByName("release")',
    "    }",
    "  }",
    "}",
    SIGNING_END
  ].join("\n");
}

/**
 * Strips the moku-managed signing block (and the blank line it was inserted with) from
 * Gradle content, leaving content that never carried one untouched.
 *
 * @param existing - The current `build.gradle.kts` content.
 * @returns The content without a moku signing block.
 * @example
 * ```ts
 * removeSigningBlock(patchedGradleKts);
 * ```
 */
export function removeSigningBlock(existing: string): string {
  const startIndex = existing.indexOf(SIGNING_START);
  const endIndex = existing.indexOf(SIGNING_END);
  if (startIndex === -1 || endIndex === -1) return existing;

  let before = existing.slice(0, startIndex);
  while (before.endsWith("\n")) before = before.slice(0, -1);

  let after = existing.slice(endIndex + SIGNING_END.length);
  while (after.startsWith("\n")) after = after.slice(1);

  return before.length > 0 ? `${before}\n${after}` : after;
}

/**
 * Idempotently inserts, replaces or removes the moku-managed signing block inside an
 * existing `app/build.gradle.kts`. Re-applying to already-patched content is a text-level
 * no-op; an unconfigured keystore REMOVES a block a previous build left behind, so
 * dropping `signing.android.keystorePath` really does return to unsigned builds.
 *
 * @param existing - The current `build.gradle.kts` content.
 * @param signing - The Android signing config slice (empty object when unconfigured).
 * @returns The patched content with exactly one signing block, or none when unconfigured.
 * @example
 * ```ts
 * applySigningBlock(gradleKts, { keystorePath: "release.jks", keyAlias: "release" });
 * ```
 */
export function applySigningBlock(
  existing: string,
  signing: NonNullable<SigningConfig["android"]>
): string {
  if (!signing.keystorePath) return removeSigningBlock(existing);

  const block = renderSigningBlock(signing, signing.keystorePath);
  const startIndex = existing.indexOf(SIGNING_START);
  const endIndex = existing.indexOf(SIGNING_END);
  if (startIndex === -1 || endIndex === -1) {
    const separator = existing.endsWith("\n") ? "" : "\n";
    return `${existing}${separator}\n${block}\n`;
  }

  const before = existing.slice(0, startIndex);
  const after = existing.slice(endIndex + SIGNING_END.length);
  return `${before}${block}${after}`;
}

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
 * `<node> <tauri.js> <verb>` invocation. Tauri writes whichever runner it DETECTED from
 * the environment (`node tauri` from a plain shell, `bun tauri` under `bun run`, also
 * `npm run tauri --`, `yarn|pnpm tauri`, `cargo tauri`), and none of those resolve inside
 * Xcode or Android Studio — so an unpatched tree fails on its first build phase.
 * The match is runner-agnostic: on every line carrying ` <verb>`, whatever sits between
 * the line's prefix and the verb is replaced.
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
 * @param opts - The patch options, with a runner guaranteed present.
 * @returns The paths patched vs. left unchanged.
 * @example
 * ```ts
 * await patchRunner(projectDir, genDir, { target: "ios", runner });
 * ```
 */
async function patchRunner(
  projectDirectory: string,
  genDirectory: string,
  opts: PatchMobileOptions & { runner: TauriRunner }
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

/**
 * Patches Android release signing into `app/build.gradle.kts`, and clears the legacy
 * `keystore.properties` a previous version of this plugin wrote. Signing now lives in
 * Gradle only, so nothing ever re-creates that file.
 *
 * @param projectDirectory - The Tauri project root.
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @param signing - The Android signing config slice (empty object when unconfigured).
 * @returns The paths patched vs. left unchanged.
 * @example
 * ```ts
 * await patchAndroidSigning(projectDir, genDir, { keystorePath: "release.jks" });
 * ```
 */
async function patchAndroidSigning(
  projectDirectory: string,
  genDirectory: string,
  signing: NonNullable<SigningConfig["android"]>
): Promise<PatchResult> {
  const patched: string[] = [];
  const unchanged: string[] = [];

  const buildGradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  const existingGradle = await readFile(buildGradlePath, "utf8");
  const action = await writeIfChanged(
    buildGradlePath,
    applySigningBlock(existingGradle, signing),
    projectDirectory
  );
  (action === "written" ? patched : unchanged).push(buildGradlePath);

  // Single named file inside gen/android, never a recursive remove.
  const keystorePropertiesPath = path.join(genDirectory, "keystore.properties");
  if (!signing.keystorePath && existsSync(keystorePropertiesPath)) {
    await rm(keystorePropertiesPath, { force: true });
    patched.push(keystorePropertiesPath);
  }

  return { patched, unchanged };
}

/**
 * Deterministic, idempotent post-init patch pass over an existing complete gen/ tree.
 * Android gets its release signing block; both platforms get the runner-command rewrite
 * when the caller supplies a `runner` (omit it and the rewrite is skipped). iOS carries no
 * mobile-permission plist mechanism in v1 (D-012), so signing is conf-only there.
 *
 * @param projectDirectory - The Tauri project root.
 * @param opts - The mobile platform, and optionally the absolute Node/tauri.js runner pair.
 * @param signing - The full signing config (only `.android` is consulted).
 * @returns The paths patched vs. left unchanged.
 * @throws {Error} When the Android `gen/android` tree (or its `app/build.gradle.kts`) is missing.
 * @example
 * ```ts
 * await patchMobile("/repo/.moku/tauri", { target: "ios", runner }, {});
 * ```
 */
export async function patchMobile(
  projectDirectory: string,
  opts: PatchMobileOptions,
  signing: SigningConfig
): Promise<PatchResult> {
  const platform = opts.target === "ios" ? "apple" : "android";
  const genDirectory = path.join(projectDirectory, "src-tauri", "gen", platform);

  if (opts.target === "ios") {
    if (!opts.runner || !existsSync(genDirectory)) return { patched: [], unchanged: [] };
    return patchRunner(projectDirectory, genDirectory, { ...opts, runner: opts.runner });
  }

  const buildGradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  if (!existsSync(genDirectory) || !existsSync(buildGradlePath)) {
    throw new Error(
      `[native] Android gen/ tree not found or incomplete at ${genDirectory}.\n  Run the mobile init pass (tauri android init) before patching signing state.`
    );
  }

  const result = await patchAndroidSigning(projectDirectory, genDirectory, signing.android ?? {});
  if (!opts.runner) return result;

  const runnerResult = await patchRunner(projectDirectory, genDirectory, {
    ...opts,
    runner: opts.runner
  });
  return {
    patched: [...result.patched, ...runnerResult.patched],
    unchanged: [...result.unchanged, ...runnerResult.unchanged]
  };
}
