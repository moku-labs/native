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
  projectYmlFor,
  RUNNER,
  YML_RUNNER
} from "./fixtures";

describe("applyRunnerCommand", () => {
  const ios = { runner: RUNNER, verb: IOS_VERB, quote: '"' };
  const iosLiteral = { runner: RUNNER, verb: IOS_VERB, quote: String.raw`\"` };
  const android = { runner: RUNNER, verb: ANDROID_VERB, quote: String.raw`\"` };

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
