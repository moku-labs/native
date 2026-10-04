/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: the real `tauri ios init` output
   carries `${PLATFORM_DISPLAY_NAME:?}` as literal shell text — these fixtures are byte-for-byte
   copies of it, so the placeholders must stay plain strings. */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyKotlinRunner, applyRunnerCommand, patchRunner } from "../../../mobile/runner";
import {
  ANDROID_VERB,
  DETECTED_RUNNERS,
  IOS_VERB,
  LITERAL_RUNNER,
  PATH_QUALIFIED_RUNNERS,
  pbxprojFor,
  pbxprojLine,
  projectYmlFor,
  RUNNER,
  YML_RUNNER,
  ymlLine
} from "./fixtures";

/** A `project.yml` script line exactly as `tauri ios init` writes it (bun-detected runner). */
const REAL_YML_LINE =
  "      - script: bun tauri ios xcode-script -v --platform ${PLATFORM_DISPLAY_NAME:?} --sdk-root ${SDKROOT:?}";

/** The same build phase inside `project.pbxproj` (node-detected runner), quotes escaped. */
const REAL_PBXPROJ_LINE = `\t\t\tshellScript = "node tauri ios xcode-script -v --platform \${PLATFORM_DISPLAY_NAME:?} --sdk-root \${SDKROOT:?} --framework-search-paths \\"\${FRAMEWORK_SEARCH_PATHS:?}\\"";`;

/**
 * `gen/android/buildSrc/src/main/java/<pkg>/kotlin/BuildTask.kt`, byte for byte as
 * `tauri android init` (cli 2.12.1) writes it when an absolute node drives it.
 */
const REAL_BUILD_TASK = readFileSync(
  fileURLToPath(new URL("fixtures/BuildTask.real.kt", import.meta.url)),
  "utf8"
);

/** The executable line in {@link REAL_BUILD_TASK}. */
const REAL_EXECUTABLE_LINE = 'val executable = """/opt/homebrew/bin/node""";';

/** The args line in {@link REAL_BUILD_TASK}. */
const REAL_ARGS_LINE = 'val args = listOf("tauri", "android", "android-studio-script");';

/**
 * {@link REAL_BUILD_TASK} with the two runner lines set to a runner's literal forms.
 * Function replacements, so a `$'` in an escaped path is not read as a replacement pattern.
 */
const buildTaskFor = (executable: string, firstArgument: string) =>
  REAL_BUILD_TASK.replace(
    REAL_EXECUTABLE_LINE,
    () => `val executable = """${executable}""";`
  ).replace(
    REAL_ARGS_LINE,
    () => `val args = listOf("${firstArgument}", "android", "android-studio-script");`
  );

/** {@link REAL_BUILD_TASK} after the rewrite onto {@link RUNNER}. */
const PATCHED_BUILD_TASK = buildTaskFor(RUNNER.nodePath, RUNNER.tauriJsPath);

describe("applyRunnerCommand", () => {
  const ios = { runner: RUNNER, verb: IOS_VERB, quote: '"' };
  const iosLiteral = { runner: RUNNER, verb: IOS_VERB, quote: String.raw`\"` };
  const android = { runner: RUNNER, verb: ANDROID_VERB, quote: String.raw`\"` };

  it("rewrites the real `bun tauri` script line from `tauri ios init`", () => {
    expect(applyRunnerCommand(REAL_YML_LINE, ios)).toBe(
      "      - script: " +
        YML_RUNNER +
        " ios xcode-script -v --platform ${PLATFORM_DISPLAY_NAME:?} --sdk-root ${SDKROOT:?}"
    );
  });

  it("rewrites the real `node tauri` pbxproj shellScript line, trailing arguments intact", () => {
    expect(applyRunnerCommand(REAL_PBXPROJ_LINE, iosLiteral)).toBe(
      `\t\t\tshellScript = "${LITERAL_RUNNER} ios xcode-script -v --platform \${PLATFORM_DISPLAY_NAME:?} --sdk-root \${SDKROOT:?} --framework-search-paths \\"\${FRAMEWORK_SEARCH_PATHS:?}\\"";`
    );
  });

  it("keeps a script preamble ahead of the runner", () => {
    const source = `\t\tshellScript = "set -e\\ncd \\"$SRCROOT\\" && node tauri ios xcode-script -v";`;

    expect(applyRunnerCommand(source, iosLiteral)).toBe(
      `\t\tshellScript = "set -e\\ncd \\"$SRCROOT\\" && ${LITERAL_RUNNER} ios xcode-script -v";`
    );
  });

  it("rewrites a CRLF file without touching its line endings", () => {
    const source = [ymlLine("bun tauri"), "          name: Build Rust Code", ""].join("\r\n");

    const rewritten = applyRunnerCommand(source, ios);

    expect(rewritten).toBe(
      [ymlLine(YML_RUNNER), "          name: Build Rust Code", ""].join("\r\n")
    );
    expect(rewritten).not.toContain("\n\n");
  });

  it("re-patches an absolute pair whose node path changed (an fnm/nvm switch)", () => {
    const stale = ymlLine('"/opt/node v18/bin/node" "/repo/node modules/@tauri-apps/cli/tauri.js"');

    expect(applyRunnerCommand(stale, ios)).toBe(ymlLine(YML_RUNNER));
  });

  it("escapes shell metacharacters in the runner paths", () => {
    const runner = {
      nodePath: "/opt/node $HOME/bin/node",
      tauriJsPath: '/repo/we"ird/`tauri`.js'
    };

    const rewritten = applyRunnerCommand(ymlLine("bun tauri"), {
      runner,
      verb: IOS_VERB,
      quote: '"'
    });

    expect(rewritten).toContain(String.raw`\$HOME`);
    expect(rewritten).toContain(String.raw`we\"ird`);
    expect(rewritten).toContain("\\`tauri\\`");
  });

  it("refuses a runner path carrying a newline", () => {
    expect(() =>
      applyRunnerCommand(ymlLine("bun tauri"), {
        runner: { nodePath: "/opt/node\nrm -rf x/bin/node", tauriJsPath: "/repo/tauri.js" },
        verb: IOS_VERB,
        quote: '"'
      })
    ).toThrow(/^\[native\] Refusing to write a runner path containing a line break/);
  });

  it.each(DETECTED_RUNNERS)("rewrites a `%s` yml script line", runner => {
    expect(applyRunnerCommand(projectYmlFor(runner), ios)).toBe(projectYmlFor(YML_RUNNER));
  });

  it.each(DETECTED_RUNNERS)("rewrites a `%s` pbxproj shellScript line", runner => {
    expect(applyRunnerCommand(pbxprojFor(runner), iosLiteral)).toBe(pbxprojFor(LITERAL_RUNNER));
  });

  it.each(DETECTED_RUNNERS)("rewrites a `%s` Android source string literal", runner => {
    const source = `val command = "${runner} android android-studio-script"\n`;
    expect(applyRunnerCommand(source, android)).toBe(
      `val command = "${LITERAL_RUNNER} android android-studio-script"\n`
    );
  });

  it.each(
    PATH_QUALIFIED_RUNNERS
  )("keeps the opening quote of a `%s` pbxproj shellScript", runner => {
    const rewritten = applyRunnerCommand(pbxprojFor(runner), iosLiteral);

    expect(rewritten).toBe(pbxprojFor(LITERAL_RUNNER));
    expect(rewritten).toContain(String.raw`shellScript = "\"/opt/node v20/bin/node\" `);
  });

  it.each(PATH_QUALIFIED_RUNNERS)("rewrites a path-qualified `%s` yml script line", runner => {
    expect(applyRunnerCommand(projectYmlFor(runner), ios)).toBe(projectYmlFor(YML_RUNNER));
  });

  it("keeps the opening quote of a path-qualified Kotlin string literal", () => {
    const source = `val command = "/opt/node/bin/node tauri android android-studio-script"\n`;

    expect(applyRunnerCommand(source, android)).toBe(
      `val command = "${LITERAL_RUNNER} android android-studio-script"\n`
    );
  });

  it("is a no-op on a path-qualified pbxproj line it already rewrote", () => {
    const once = applyRunnerCommand(pbxprojFor("/opt/homebrew/bin/node tauri"), iosLiteral);

    expect(applyRunnerCommand(once, iosLiteral)).toBe(once);
  });

  it("is a no-op on already-patched yml (absolute paths containing spaces)", () => {
    const patched = projectYmlFor(YML_RUNNER);
    expect(applyRunnerCommand(patched, ios)).toBe(patched);
  });

  it("is a no-op on an already-patched pbxproj shellScript line", () => {
    const patched = pbxprojFor(LITERAL_RUNNER);
    expect(applyRunnerCommand(patched, iosLiteral)).toBe(patched);
  });

  it("leaves lines that do not carry the verb untouched", () => {
    const source = ["# bun tauri build", "          name: Build Rust Code", ""].join("\n");
    expect(applyRunnerCommand(source, ios)).toBe(source);
  });

  it("does not touch the Android verb while patching the iOS one", () => {
    const source = `val command = "bun tauri android android-studio-script"\n`;
    expect(applyRunnerCommand(source, ios)).toBe(source);
  });
});

describe("patchRunner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-runner-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports an empty result when the platform has no runner-carrying file", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(genDir, { recursive: true });

    const result = await patchRunner(dir, genDir, { target: "ios", runner: RUNNER });

    expect(result).toEqual({ patched: [], unchanged: [] });
  });

  it("patches the project.pbxproj of every generated xcodeproj directory", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    const projects = ["app_iOS.xcodeproj", "app_iOS-legacy.xcodeproj"];
    for (const project of projects) {
      await mkdir(path.join(genDir, project), { recursive: true });
      await writeFile(
        path.join(genDir, project, "project.pbxproj"),
        pbxprojFor("bun tauri"),
        "utf8"
      );
    }

    const result = await patchRunner(dir, genDir, { target: "ios", runner: RUNNER });

    expect(result.patched.toSorted()).toEqual(
      projects.map(project => path.join(genDir, project, "project.pbxproj")).toSorted()
    );
    for (const project of projects) {
      expect(await readFile(path.join(genDir, project, "project.pbxproj"), "utf8")).toContain(
        pbxprojLine(LITERAL_RUNNER)
      );
    }
  });

  it("reports an already-current runner as unchanged", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(genDir, { recursive: true });
    const projectYml = path.join(genDir, "project.yml");
    await writeFile(projectYml, projectYmlFor(YML_RUNNER), "utf8");

    const result = await patchRunner(dir, genDir, { target: "ios", runner: RUNNER });

    expect(result).toEqual({ patched: [], unchanged: [projectYml] });
  });

  it("throws when a file carries the verb but no recognizable runner before it", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(genDir, { recursive: true });
    const projectYml = path.join(genDir, "project.yml");
    await writeFile(projectYml, projectYmlFor("deno task tauri-cli"), "utf8");

    await expect(patchRunner(dir, genDir, { target: "ios", runner: RUNNER })).rejects.toThrow(
      `[native] Could not find a Tauri runner command before "ios xcode-script" in ${projectYml}.\n  Set pluginConfigs.tauri.nodePath, or report the runner line Tauri generated.`
    );
  });

  it("throws for an unrecognizable Android runner too", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "android");
    await mkdir(genDir, { recursive: true });
    const gradleFile = path.join(genDir, "build.gradle.kts");
    await writeFile(
      gradleFile,
      'val command = "deno task tauri-cli android android-studio-script"'
    );

    await expect(patchRunner(dir, genDir, { target: "android", runner: RUNNER })).rejects.toThrow(
      `[native] Could not find a Tauri runner command before "android android-studio-script" in ${gradleFile}.`
    );
  });

  it("leaves a file that never mentions the verb unchanged", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(genDir, { recursive: true });
    const projectYml = path.join(genDir, "project.yml");
    await writeFile(projectYml, "targets:\n  MyApp_iOS:\n    type: application\n", "utf8");

    const result = await patchRunner(dir, genDir, { target: "ios", runner: RUNNER });

    expect(result).toEqual({ patched: [], unchanged: [projectYml] });
  });

  it("skips derived Android build output while patching buildSrc sources", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "android");
    const sourceDir = path.join(genDir, "buildSrc", "src", "main", "java");
    const derivedDir = path.join(genDir, "buildSrc", "build", "generated");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(derivedDir, { recursive: true });
    const sourcePath = path.join(sourceDir, "BuildTask.kt");
    const derivedPath = path.join(derivedDir, "BuildTask.kt");
    const content = 'val command = "node tauri android android-studio-script"\n';
    await writeFile(sourcePath, content, "utf8");
    await writeFile(derivedPath, content, "utf8");

    const result = await patchRunner(dir, genDir, { target: "android", runner: RUNNER });

    expect(result.patched).toEqual([sourcePath]);
    expect(await readFile(derivedPath, "utf8")).toBe(content);
  });
});

describe("applyKotlinRunner", () => {
  it("rewrites the real BuildTask.kt executable and first argument, nothing else", () => {
    expect(PATCHED_BUILD_TASK).not.toBe(REAL_BUILD_TASK);
    expect(applyKotlinRunner(REAL_BUILD_TASK, RUNNER)).toBe(PATCHED_BUILD_TASK);
  });

  it("is a no-op on a BuildTask.kt it already rewrote", () => {
    expect(applyKotlinRunner(PATCHED_BUILD_TASK, RUNNER)).toBe(PATCHED_BUILD_TASK);
  });

  it("re-patches both lines when the node path changed (an fnm switch)", () => {
    const switched = {
      nodePath: "/Users/me/.local/state/fnm_multishells/123_456/bin/node",
      tauriJsPath: "/repo/other/node_modules/@tauri-apps/cli/tauri.js"
    };

    expect(applyKotlinRunner(PATCHED_BUILD_TASK, switched)).toBe(
      buildTaskFor(switched.nodePath, switched.tauriJsPath)
    );
  });

  it("collapses a multi-word runner prefix (npm run -- tauri) to the tauri.js path", () => {
    const npm = REAL_BUILD_TASK.replace(
      REAL_ARGS_LINE,
      'val args = listOf("run", "--", "tauri", "android", "android-studio-script");'
    );

    expect(applyKotlinRunner(npm, RUNNER)).toBe(PATCHED_BUILD_TASK);
  });

  it("escapes a quote, a dollar and a backslash for each Kotlin literal", () => {
    const runner = {
      nodePath: String.raw`/opt/we"ird $HOME\node`,
      tauriJsPath: String.raw`/repo/we"ird $x\tauri.js`
    };

    expect(applyKotlinRunner(REAL_BUILD_TASK, runner)).toBe(
      buildTaskFor(
        // Raw string: no backslash escapes, so `"` and `$` go through `${'…'}` templates.
        "/opt/we${'\"'}ird ${'$'}HOME\\node",
        // Plain string: backslash escapes.
        String.raw`/repo/we\"ird \$x\\tauri.js`
      )
    );
  });

  it("refuses a runner path carrying a line break", () => {
    expect(() =>
      applyKotlinRunner(REAL_BUILD_TASK, { nodePath: "/opt/node\nx", tauriJsPath: "/t.js" })
    ).toThrow(/^\[native\] Refusing to write a runner path containing a line break/);
  });

  it("leaves an executable alone when the file has no android-studio-script args", () => {
    const source = 'val executable = """/opt/homebrew/bin/node""";\n';

    expect(applyKotlinRunner(source, RUNNER)).toBe(source);
  });
});

describe("patchRunner on the Kotlin BuildTask shape", () => {
  let dir: string;
  let genDir: string;
  let buildTask: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-runner-kt-"));
    genDir = path.join(dir, "src-tauri", "gen", "android");
    const kotlinDir = path.join(
      genDir,
      "buildSrc",
      "src",
      "main",
      "java",
      "com",
      "example",
      "app",
      "kotlin"
    );
    await mkdir(kotlinDir, { recursive: true });
    buildTask = path.join(kotlinDir, "BuildTask.kt");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the real BuildTask.kt as patched and writes the absolute runner", async () => {
    await writeFile(buildTask, REAL_BUILD_TASK, "utf8");

    const result = await patchRunner(dir, genDir, { target: "android", runner: RUNNER });

    expect(result).toEqual({ patched: [buildTask], unchanged: [] });
    expect(await readFile(buildTask, "utf8")).toBe(PATCHED_BUILD_TASK);
  });

  it("reports it unchanged on the second pass", async () => {
    await writeFile(buildTask, REAL_BUILD_TASK, "utf8");
    await patchRunner(dir, genDir, { target: "android", runner: RUNNER });

    const result = await patchRunner(dir, genDir, { target: "android", runner: RUNNER });

    expect(result).toEqual({ patched: [], unchanged: [buildTask] });
  });

  it.each([
    [
      "the executable is not a raw string",
      REAL_BUILD_TASK.replace(REAL_EXECUTABLE_LINE, 'val executable = "node";')
    ],
    [
      "the verb args are not in a listOf",
      REAL_BUILD_TASK.replace(
        REAL_ARGS_LINE,
        'val args = arrayOf("tauri", "android", "android-studio-script");'
      )
    ]
  ])("throws the unknown-runner error when %s", async (_case, content) => {
    await writeFile(buildTask, content, "utf8");

    await expect(patchRunner(dir, genDir, { target: "android", runner: RUNNER })).rejects.toThrow(
      `[native] Could not find a Tauri runner command before "android android-studio-script" in ${buildTask}.`
    );
  });
});
