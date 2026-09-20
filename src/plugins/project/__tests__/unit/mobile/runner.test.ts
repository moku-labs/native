/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: the real `tauri ios init` output
   carries `${PLATFORM_DISPLAY_NAME:?}` as literal shell text — these fixtures are byte-for-byte
   copies of it, so the placeholders must stay plain strings. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyRunnerCommand, patchRunner } from "../../../mobile/runner";
import {
  ANDROID_VERB,
  DETECTED_RUNNERS,
  IOS_VERB,
  LITERAL_RUNNER,
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
