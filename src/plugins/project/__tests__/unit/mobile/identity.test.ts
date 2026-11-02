import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAndroidApplicationId, setAsideStaleAndroidTree } from "../../../mobile/identity";

/** `app/build.gradle.kts` as `tauri android init` (cli 2.12) writes it, trimmed to the id lines. */
const gradleFor = (identifier: string) =>
  [
    "android {",
    "    compileSdk = 36",
    `    namespace = "${identifier}"`,
    "    defaultConfig {",
    `        applicationId = "${identifier}"`,
    "    }",
    "    buildTypes {",
    '        getByName("debug") {',
    '            applicationIdSuffix = ".debug"',
    "        }",
    "    }",
    "}",
    ""
  ].join("\n");

describe("android tree identity", () => {
  let dir: string;
  let genDir: string;

  /** Writes a `gen/android` fixture initialised for `identifier`, with a user keystore in it. */
  const initTreeFor = async (identifier: string) => {
    await mkdir(path.join(genDir, "app"), { recursive: true });
    await writeFile(path.join(genDir, "app", "build.gradle.kts"), gradleFor(identifier), "utf8");
    await writeFile(path.join(genDir, "app", "release.jks"), "keystore", "utf8");
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-identity-"));
    genDir = path.join(dir, "src-tauri", "gen", "android");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads applicationId, not the debug suffix", async () => {
    await initTreeFor("com.mokulabs.memorymissing");

    expect(readAndroidApplicationId(genDir)).toBe("com.mokulabs.memorymissing");
  });

  it("reads nothing from a tree without build.gradle.kts", () => {
    expect(readAndroidApplicationId(genDir)).toBeUndefined();
  });

  it("moves a tree made for an old id aside, keeping its files (bug: the build reuses gen/android for com.mokulabs.* after the id changed and fails)", async () => {
    await initTreeFor("com.mokulabs.memorymissing");

    const result = await setAsideStaleAndroidTree({
      genDirectory: genDir,
      identifier: "studio.kitto.memorymissing"
    });

    const movedTo = path.join(dir, "src-tauri", "gen", "android.old-com.mokulabs.memorymissing");
    expect(result).toEqual({
      found: "com.mokulabs.memorymissing",
      expected: "studio.kitto.memorymissing",
      movedTo
    });
    expect(existsSync(genDir)).toBe(false);
    // Moved, never deleted: the keystore a user put there survives.
    await expect(readFile(path.join(movedTo, "app", "release.jks"), "utf8")).resolves.toBe(
      "keystore"
    );
  });

  it("reuses a tree made for the same id (bug: every build regenerates gen/android and loses its patches)", async () => {
    await initTreeFor("studio.kitto.memorymissing");

    const result = await setAsideStaleAndroidTree({
      genDirectory: genDir,
      identifier: "studio.kitto.memorymissing"
    });

    expect(result).toBeUndefined();
    expect(existsSync(path.join(genDir, "app", "build.gradle.kts"))).toBe(true);
  });

  it("matches an id with dashes against the underscores Tauri may write", async () => {
    await initTreeFor("com.acme.my_app");

    const result = await setAsideStaleAndroidTree({
      genDirectory: genDir,
      identifier: "com.acme.my-app"
    });

    expect(result).toBeUndefined();
  });

  it("leaves a tree it cannot read an id from to the completeness gate", async () => {
    await mkdir(genDir, { recursive: true });

    const result = await setAsideStaleAndroidTree({
      genDirectory: genDir,
      identifier: "studio.kitto.memorymissing"
    });

    expect(result).toBeUndefined();
    expect(existsSync(genDir)).toBe(true);
  });

  it("never overwrites an earlier set-aside tree", async () => {
    const earlier = path.join(dir, "src-tauri", "gen", "android.old-com.mokulabs.memorymissing");
    await mkdir(earlier, { recursive: true });
    await mkdir(`${earlier}-2`, { recursive: true });
    await initTreeFor("com.mokulabs.memorymissing");

    const result = await setAsideStaleAndroidTree({
      genDirectory: genDir,
      identifier: "studio.kitto.memorymissing"
    });

    expect(result?.movedTo).toBe(`${earlier}-3`);
    expect(existsSync(earlier)).toBe(true);
    expect(existsSync(`${earlier}-2`)).toBe(true);
  });
});
