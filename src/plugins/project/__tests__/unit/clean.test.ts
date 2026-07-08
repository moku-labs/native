import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertWithinRoot, clean, cleanTargets } from "../../clean";

describe("cleanTargets", () => {
  it("scopes to the whole projectDir when target is omitted", () => {
    expect(cleanTargets("/repo/.moku/tauri")).toEqual([path.resolve("/repo/.moku/tauri")]);
  });

  it("scopes mobile targets to gen/<platform> only", () => {
    expect(cleanTargets("/repo/.moku/tauri", "android")).toEqual([
      path.resolve("/repo/.moku/tauri/src-tauri/gen/android")
    ]);
    expect(cleanTargets("/repo/.moku/tauri", "ios")).toEqual([
      path.resolve("/repo/.moku/tauri/src-tauri/gen/apple")
    ]);
  });

  it("scopes desktop targets to Tauri's format-named bundle directories", () => {
    const bundle = "/repo/.moku/tauri/src-tauri/target/release/bundle";
    expect(cleanTargets("/repo/.moku/tauri", "macos")).toEqual([
      path.resolve(bundle, "dmg"),
      path.resolve(bundle, "macos")
    ]);
    expect(cleanTargets("/repo/.moku/tauri", "windows")).toEqual([
      path.resolve(bundle, "nsis"),
      path.resolve(bundle, "msi")
    ]);
    expect(cleanTargets("/repo/.moku/tauri", "linux")).toEqual([
      path.resolve(bundle, "appimage"),
      path.resolve(bundle, "deb"),
      path.resolve(bundle, "rpm")
    ]);
  });
});

describe("assertWithinRoot", () => {
  it("allows the root itself", () => {
    expect(() => assertWithinRoot("/repo/.moku/tauri", "/repo/.moku/tauri")).not.toThrow();
  });

  it("allows a nested path", () => {
    expect(() =>
      assertWithinRoot("/repo/.moku/tauri", "/repo/.moku/tauri/src-tauri/gen/android")
    ).not.toThrow();
  });

  it("refuses a path outside the root", () => {
    expect(() => assertWithinRoot("/repo/.moku/tauri", "/etc/passwd")).toThrow(
      "[native] Refusing to clean path outside projectDir"
    );
  });

  it("refuses a sibling path with a shared prefix", () => {
    expect(() => assertWithinRoot("/repo/.moku/tauri", "/repo/.moku/tauri-evil")).toThrow(
      "[native] Refusing to clean path outside projectDir"
    );
  });
});

describe("clean", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-clean-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes gen/<platform> for a mobile target", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "android");
    await mkdir(genDir, { recursive: true });
    await writeFile(path.join(genDir, "marker"), "x", "utf8");

    const result = await clean(dir, "android");

    expect(existsSync(genDir)).toBe(false);
    expect(result.removed).toEqual([path.resolve(genDir)]);
  });

  it("reports nothing removed when the target path does not exist", async () => {
    const result = await clean(dir, "android");
    expect(result.removed).toEqual([]);
  });

  it("removes every format-named bundle directory for a desktop target", async () => {
    const bundle = path.join(dir, "src-tauri", "target", "release", "bundle");
    const nsisDir = path.join(bundle, "nsis");
    const msiDir = path.join(bundle, "msi");
    await mkdir(nsisDir, { recursive: true });
    await mkdir(msiDir, { recursive: true });
    await writeFile(path.join(nsisDir, "app-setup.exe"), "x", "utf8");
    await writeFile(path.join(msiDir, "app.msi"), "x", "utf8");

    const result = await clean(dir, "windows");

    expect(existsSync(nsisDir)).toBe(false);
    expect(existsSync(msiDir)).toBe(false);
    expect(result.removed).toEqual([path.resolve(nsisDir), path.resolve(msiDir)]);
  });

  it("removes the whole projectDir when target is omitted", async () => {
    await writeFile(path.join(dir, "marker"), "x", "utf8");

    const result = await clean(dir);

    expect(existsSync(dir)).toBe(false);
    expect(result.removed).toEqual([path.resolve(dir)]);
  });
});
