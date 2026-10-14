import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../../../../../config";
import { assertShellLinked, checkShellLinked } from "../../../mobile/shell-link";
import { baseGlobalConfig } from "../generators/fixtures";

/** The error a tree initialised before the shell was added fails with. */
const NOT_LINKED =
  "[native] the shell plugin is not linked into gen/android (tree initialised before the shell was added).\n  Run clean for android and build again.";

/** `gen/android/tauri.settings.gradle` as the Tauri CLI writes it for one plugin. */
const settingsFor = (plugin: string) =>
  `include ':${plugin}'\nproject(':${plugin}').projectDir = new File("../../plugins/x/android")\n`;

describe("shell linkage", () => {
  let dir: string;
  let genDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-shell-link-"));
    genDir = path.join(dir, "src-tauri", "gen", "android");
    settingsPath = path.join(genDir, "tauri.settings.gradle");
    await mkdir(genDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A config composing exactly `system`. */
  const composing = (system: Config["system"]): Config => ({
    ...baseGlobalConfig,
    projectDir: dir,
    system,
    capabilities: {}
  });

  it("passes when tauri.settings.gradle names moku-shell", async () => {
    await writeFile(settingsPath, settingsFor("tauri-plugin-moku-shell"), "utf8");

    await expect(assertShellLinked({ genDirectory: genDir })).resolves.toBeUndefined();
  });

  it("fails with the clean-and-rebuild fix when moku-shell is not linked (bug: every __MOKU_NATIVE__ call fails at runtime with no build error)", async () => {
    await expect(assertShellLinked({ genDirectory: genDir })).rejects.toThrow(NOT_LINKED);

    await writeFile(settingsPath, settingsFor("tauri-plugin-haptics"), "utf8");
    await expect(assertShellLinked({ genDirectory: genDir })).rejects.toThrow(NOT_LINKED);
  });

  it("checks a debug android build even without a system entry (bug: a debug build without the console bridge passes the link check)", async () => {
    await writeFile(settingsPath, settingsFor("tauri-plugin-haptics"), "utf8");

    await expect(
      checkShellLinked({ global: composing([]), target: "android", profile: "debug" })
    ).rejects.toThrow(NOT_LINKED);
  });

  it("is a no-op for a store build that does not compose shell", async () => {
    await expect(
      checkShellLinked({
        global: composing([{ name: "haptics" }]),
        target: "android",
        profile: "store"
      })
    ).resolves.toBeUndefined();
  });
});
