import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readAndroidApplicationId,
  readAppleBundleIdentifier,
  setAsideStaleMobileTree
} from "../../../mobile/identity";

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

    const result = await setAsideStaleMobileTree({
      target: "android",
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

    const result = await setAsideStaleMobileTree({
      target: "android",
      genDirectory: genDir,
      identifier: "studio.kitto.memorymissing"
    });

    expect(result).toBeUndefined();
    expect(existsSync(path.join(genDir, "app", "build.gradle.kts"))).toBe(true);
  });

  it("matches an id with dashes against the underscores Tauri may write", async () => {
    await initTreeFor("com.acme.my_app");

    const result = await setAsideStaleMobileTree({
      target: "android",
      genDirectory: genDir,
      identifier: "com.acme.my-app"
    });

    expect(result).toBeUndefined();
  });

  it("leaves a tree it cannot read an id from to the completeness gate", async () => {
    await mkdir(genDir, { recursive: true });

    const result = await setAsideStaleMobileTree({
      target: "android",
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

    const result = await setAsideStaleMobileTree({
      target: "android",
      genDirectory: genDir,
      identifier: "studio.kitto.memorymissing"
    });

    expect(result?.movedTo).toBe(`${earlier}-3`);
    expect(existsSync(earlier)).toBe(true);
    expect(existsSync(`${earlier}-2`)).toBe(true);
  });
});

describe("apple tree identity", () => {
  let dir: string;
  let genDir: string;

  /** Writes a `gen/apple` fixture initialised for `identifier`: the real project.yml plus a hand edit. */
  const initTreeFor = async (identifier: string) => {
    const real = await readFile(
      path.join(import.meta.dirname, "fixtures", "project.real.yml"),
      "utf8"
    );
    await mkdir(genDir, { recursive: true });
    await writeFile(
      path.join(genDir, "project.yml"),
      real.replaceAll("com.mokulabs.storeprobe", identifier),
      "utf8"
    );
    await writeFile(path.join(genDir, "ExportOptions.plist"), "hand edit", "utf8");
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-identity-"));
    genDir = path.join(dir, "src-tauri", "gen", "apple");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads PRODUCT_BUNDLE_IDENTIFIER from project.yml", async () => {
    await initTreeFor("com.mokulabs.memorymissing");

    expect(readAppleBundleIdentifier(genDir)).toBe("com.mokulabs.memorymissing");
  });

  it("reads a quoted bundle id without its quotes", async () => {
    await mkdir(genDir, { recursive: true });
    await writeFile(
      path.join(genDir, "project.yml"),
      'settingGroups:\n  app:\n    base:\n      PRODUCT_BUNDLE_IDENTIFIER: "com.acme.demo"\n',
      "utf8"
    );

    expect(readAppleBundleIdentifier(genDir)).toBe("com.acme.demo");
  });

  it("reads nothing from a tree without project.yml", () => {
    expect(readAppleBundleIdentifier(genDir)).toBeUndefined();
  });

  it("moves a tree made for an old id aside, keeping its files (bug: the iOS build reuses gen/apple with the old bundle id after the id changed)", async () => {
    await initTreeFor("com.mokulabs.memorymissing");

    const result = await setAsideStaleMobileTree({
      target: "ios",
      genDirectory: genDir,
      identifier: "studio.kitto.memorymissing"
    });

    const movedTo = path.join(dir, "src-tauri", "gen", "apple.old-com.mokulabs.memorymissing");
    expect(result).toEqual({
      found: "com.mokulabs.memorymissing",
      expected: "studio.kitto.memorymissing",
      movedTo
    });
    expect(existsSync(genDir)).toBe(false);
    // Moved, never deleted: a hand edit in the tree survives.
    await expect(readFile(path.join(movedTo, "ExportOptions.plist"), "utf8")).resolves.toBe(
      "hand edit"
    );
  });

  it("reuses a tree made for the same id (bug: every iOS build regenerates gen/apple and loses its patches)", async () => {
    await initTreeFor("studio.kitto.memorymissing");

    const result = await setAsideStaleMobileTree({
      target: "ios",
      genDirectory: genDir,
      identifier: "studio.kitto.memorymissing"
    });

    expect(result).toBeUndefined();
    expect(existsSync(path.join(genDir, "project.yml"))).toBe(true);
  });

  it("leaves a tree whose project.yml names no bundle id to the completeness gate (bug: an unreadable tree is moved aside on every build)", async () => {
    await mkdir(genDir, { recursive: true });
    await writeFile(path.join(genDir, "project.yml"), "name: store-probe\n", "utf8");

    const result = await setAsideStaleMobileTree({
      target: "ios",
      genDirectory: genDir,
      identifier: "studio.kitto.memorymissing"
    });

    expect(result).toBeUndefined();
    expect(existsSync(path.join(genDir, "project.yml"))).toBe(true);
  });

  it("matches an id with underscores against the dashes Tauri writes for Apple", async () => {
    await initTreeFor("com.acme.my-app");

    const result = await setAsideStaleMobileTree({
      target: "ios",
      genDirectory: genDir,
      identifier: "com.acme.my_app"
    });

    expect(result).toBeUndefined();
  });
});
