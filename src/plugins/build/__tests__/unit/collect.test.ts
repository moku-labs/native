import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TARGETS } from "../../../../config";
import { BUNDLE_LOCATIONS, bundleRoot, collectArtifacts } from "../../collect";

describe("BUNDLE_LOCATIONS", () => {
  it("has a non-empty glob pattern list for every target", () => {
    for (const target of TARGETS) {
      expect(BUNDLE_LOCATIONS[target].length).toBeGreaterThan(0);
    }
  });
});

describe("bundleRoot", () => {
  it("resolves desktop targets under src-tauri/target/release", () => {
    expect(bundleRoot("/repo/.moku/tauri", "macos")).toBe(
      path.join("/repo/.moku/tauri", "src-tauri", "target", "release")
    );
    expect(bundleRoot("/repo/.moku/tauri", "windows")).toBe(
      path.join("/repo/.moku/tauri", "src-tauri", "target", "release")
    );
    expect(bundleRoot("/repo/.moku/tauri", "linux")).toBe(
      path.join("/repo/.moku/tauri", "src-tauri", "target", "release")
    );
  });

  it("resolves mobile targets under src-tauri directly (the gen/<platform> tree)", () => {
    expect(bundleRoot("/repo/.moku/tauri", "ios")).toBe(
      path.join("/repo/.moku/tauri", "src-tauri")
    );
    expect(bundleRoot("/repo/.moku/tauri", "android")).toBe(
      path.join("/repo/.moku/tauri", "src-tauri")
    );
  });
});

describe("collectArtifacts", () => {
  let projectDir: string;
  let outDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-collect-project-"));
    outDir = await mkdtemp(path.join(tmpdir(), "moku-native-collect-out-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it("copies a single matched installer to outDir/<target>/", async () => {
    const dmgDir = path.join(bundleRoot(projectDir, "macos"), "bundle", "dmg");
    await mkdir(dmgDir, { recursive: true });
    await writeFile(path.join(dmgDir, "MyApp_1.0.0_aarch64.dmg"), "dmg-bytes", "utf8");

    const result = await collectArtifacts(projectDir, "macos", outDir);

    expect(result.outPath).toBe(path.join(outDir, "macos"));
    expect(result.artifacts).toEqual([path.join(outDir, "macos", "MyApp_1.0.0_aarch64.dmg")]);
    expect(await readFile(result.artifacts[0] as string, "utf8")).toBe("dmg-bytes");
  });

  it("copies a directory bundle (.app) recursively", async () => {
    const appDir = path.join(bundleRoot(projectDir, "macos"), "bundle", "macos", "MyApp.app");
    await mkdir(path.join(appDir, "Contents"), { recursive: true });
    await writeFile(path.join(appDir, "Contents", "Info.plist"), "plist-bytes", "utf8");

    const result = await collectArtifacts(projectDir, "macos", outDir);

    const copiedApp = path.join(outDir, "macos", "MyApp.app");
    expect(result.artifacts).toContain(copiedApp);
    expect(existsSync(path.join(copiedApp, "Contents", "Info.plist"))).toBe(true);
  });

  it("copies every match across multiple glob patterns for a target", async () => {
    const root = bundleRoot(projectDir, "linux");
    await mkdir(path.join(root, "bundle", "appimage"), { recursive: true });
    await mkdir(path.join(root, "bundle", "deb"), { recursive: true });
    await mkdir(path.join(root, "bundle", "rpm"), { recursive: true });
    await writeFile(path.join(root, "bundle", "appimage", "app.AppImage"), "a", "utf8");
    await writeFile(path.join(root, "bundle", "deb", "app.deb"), "b", "utf8");
    await writeFile(path.join(root, "bundle", "rpm", "app.rpm"), "c", "utf8");

    const result = await collectArtifacts(projectDir, "linux", outDir);

    expect(result.artifacts.map(artifact => path.basename(artifact)).toSorted()).toEqual([
      "app.AppImage",
      "app.deb",
      "app.rpm"
    ]);
  });

  it("matches mobile installers under the gen/<platform> tree", async () => {
    const root = bundleRoot(projectDir, "android");
    const outputsDir = path.join(
      root,
      "gen",
      "android",
      "app",
      "build",
      "outputs",
      "apk",
      "release"
    );
    await mkdir(outputsDir, { recursive: true });
    await writeFile(path.join(outputsDir, "app-release.apk"), "apk-bytes", "utf8");

    const result = await collectArtifacts(projectDir, "android", outDir);

    expect(result.artifacts).toEqual([path.join(outDir, "android", "app-release.apk")]);
  });

  it("throws a [native]-formatted error naming the globbed roots when nothing matches", async () => {
    await expect(collectArtifacts(projectDir, "macos", outDir)).rejects.toThrow(
      /^\[native\] No macos installer artifacts found\.\n {2}Checked .*bundle\/dmg\/\*\.dmg.*bundle\/macos\/\*\.app/
    );
  });
});
