import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TARGETS } from "../../../../config";
import { bundleLayout } from "../../../project/layout";
import { comparableRealPath } from "../../../project/paths";
import { artifactDestination, bundlePatterns, bundleRoot, collectArtifacts } from "../../collect";

/** The real resolver the pipeline threads in, from `project.resolveDerivedPath`. */
const resolvePath = (target: string): string => comparableRealPath(target);

/** Timestamps far enough apart that no filesystem's mtime granularity can blur them. */
const OLDER = new Date(Date.now() - 600_000);
const NEWER = new Date(Date.now() - 1000);

describe("bundlePatterns", () => {
  it("has a non-empty glob pattern list for every target", () => {
    for (const target of TARGETS) {
      expect(bundlePatterns(bundleLayout(target), target).length).toBeGreaterThan(0);
    }
  });

  it("covers both simulator directory layouts for an ios simulator build", () => {
    expect(bundlePatterns(bundleLayout("ios"), "ios", { simulator: true })).toEqual([
      "gen/apple/build/*-sim/*.app",
      "gen/apple/build/x86_64/*.app"
    ]);
  });
});

describe("bundleRoot", () => {
  it("resolves desktop targets under src-tauri/target/release", () => {
    expect(bundleRoot("/repo/.moku/tauri", bundleLayout("macos"))).toBe(
      path.join("/repo/.moku/tauri", "src-tauri", "target", "release")
    );
    expect(bundleRoot("/repo/.moku/tauri", bundleLayout("windows"))).toBe(
      path.join("/repo/.moku/tauri", "src-tauri", "target", "release")
    );
    expect(bundleRoot("/repo/.moku/tauri", bundleLayout("linux"))).toBe(
      path.join("/repo/.moku/tauri", "src-tauri", "target", "release")
    );
  });

  it("resolves mobile targets under src-tauri directly (the gen/<platform> tree)", () => {
    expect(bundleRoot("/repo/.moku/tauri", bundleLayout("ios"))).toBe(
      path.join("/repo/.moku/tauri", "src-tauri")
    );
    expect(bundleRoot("/repo/.moku/tauri", bundleLayout("android"))).toBe(
      path.join("/repo/.moku/tauri", "src-tauri")
    );
  });
});

describe("artifactDestination", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "moku-native-destination-out-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("joins the artifact name onto the target's delivery directory", () => {
    const outPath = path.join(outDir, "macos");

    expect(
      artifactDestination({
        outputDirectory: outDir,
        outPath,
        artifactName: "App.dmg",
        resolvePath
      })
    ).toBe(path.join(outPath, "App.dmg"));
  });

  it("refuses an artifact name that escapes the delivery directory", () => {
    const outPath = path.join(outDir, "macos");

    expect(() =>
      artifactDestination({
        outputDirectory: outDir,
        outPath,
        artifactName: "../escaped.dmg",
        resolvePath
      })
    ).toThrow(/^\[native\] Refusing to collect/);
    expect(() =>
      artifactDestination({ outputDirectory: outDir, outPath, artifactName: "..", resolvePath })
    ).toThrow(/^\[native\] Refusing to collect/);
  });

  it("refuses a delivery directory that is a symlink out of the output directory", async () => {
    // A lexical guard reads `<outDir>/macos` as contained. Only a real-path guard sees that
    // the collect pass is about to `rm -r` a directory in a different tree entirely.
    const escapeTarget = await mkdtemp(path.join(tmpdir(), "moku-native-destination-escape-"));
    const outPath = path.join(outDir, "macos");
    await symlink(escapeTarget, outPath, "dir");

    try {
      expect(() =>
        artifactDestination({
          outputDirectory: outDir,
          outPath,
          artifactName: "App.dmg",
          resolvePath
        })
      ).toThrow(/^\[native\] Refusing to collect/);
    } finally {
      // Explicit unlink: the symlink is removed, never followed.
      await unlink(outPath);
      await rm(escapeTarget, { recursive: true, force: true });
    }
  });

  it("refuses a delivery directory that is not strictly inside the output directory", () => {
    expect(() =>
      artifactDestination({
        outputDirectory: outDir,
        outPath: outDir,
        artifactName: "App.dmg",
        resolvePath
      })
    ).toThrow(/^\[native\] Refusing to collect/);
    expect(() =>
      artifactDestination({
        outputDirectory: outDir,
        outPath: path.join(outDir, "..", "elsewhere"),
        artifactName: "App.dmg",
        resolvePath
      })
    ).toThrow(/^\[native\] Refusing to collect/);
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
    const dmgDir = path.join(bundleRoot(projectDir, bundleLayout("macos")), "bundle", "dmg");
    await mkdir(dmgDir, { recursive: true });
    await writeFile(path.join(dmgDir, "MyApp_1.0.0_aarch64.dmg"), "dmg-bytes", "utf8");

    const result = await collectArtifacts(projectDir, "macos", outDir, bundleLayout("macos"), {
      resolvePath
    });

    expect(result.outPath).toBe(path.join(outDir, "macos"));
    expect(result.artifacts).toEqual([path.join(outDir, "macos", "MyApp_1.0.0_aarch64.dmg")]);
    expect(await readFile(result.artifacts[0] as string, "utf8")).toBe("dmg-bytes");
  });

  it("copies a directory bundle (.app) recursively", async () => {
    const appDir = path.join(
      bundleRoot(projectDir, bundleLayout("macos")),
      "bundle",
      "macos",
      "MyApp.app"
    );
    await mkdir(path.join(appDir, "Contents"), { recursive: true });
    await writeFile(path.join(appDir, "Contents", "Info.plist"), "plist-bytes", "utf8");

    const result = await collectArtifacts(projectDir, "macos", outDir, bundleLayout("macos"), {
      resolvePath
    });

    const copiedApp = path.join(outDir, "macos", "MyApp.app");
    expect(result.artifacts).toContain(copiedApp);
    expect(existsSync(path.join(copiedApp, "Contents", "Info.plist"))).toBe(true);
  });

  it("replaces a stale bundle directory instead of merging into it", async () => {
    const appDir = path.join(
      bundleRoot(projectDir, bundleLayout("macos")),
      "bundle",
      "macos",
      "MyApp.app"
    );
    await mkdir(path.join(appDir, "Contents"), { recursive: true });
    await writeFile(path.join(appDir, "Contents", "Info.plist"), "fresh-plist", "utf8");

    const staleApp = path.join(outDir, "macos", "MyApp.app");
    await mkdir(path.join(staleApp, "Contents"), { recursive: true });
    await writeFile(path.join(staleApp, "Contents", "Stale.dylib"), "stale-bytes", "utf8");

    await collectArtifacts(projectDir, "macos", outDir, bundleLayout("macos"), { resolvePath });

    // A merged copy would leave the stale file inside the bundle and break its signature.
    expect(existsSync(path.join(staleApp, "Contents", "Stale.dylib"))).toBe(false);
    expect(await readFile(path.join(staleApp, "Contents", "Info.plist"), "utf8")).toBe(
      "fresh-plist"
    );
  });

  it("copies every match across multiple glob patterns for a target", async () => {
    const root = bundleRoot(projectDir, bundleLayout("linux"));
    await mkdir(path.join(root, "bundle", "appimage"), { recursive: true });
    await mkdir(path.join(root, "bundle", "deb"), { recursive: true });
    await mkdir(path.join(root, "bundle", "rpm"), { recursive: true });
    await writeFile(path.join(root, "bundle", "appimage", "app.AppImage"), "a", "utf8");
    await writeFile(path.join(root, "bundle", "deb", "app.deb"), "b", "utf8");
    await writeFile(path.join(root, "bundle", "rpm", "app.rpm"), "c", "utf8");

    const result = await collectArtifacts(projectDir, "linux", outDir, bundleLayout("linux"), {
      resolvePath
    });

    expect(result.artifacts.map(artifact => path.basename(artifact)).toSorted()).toEqual([
      "app.AppImage",
      "app.deb",
      "app.rpm"
    ]);
  });

  it("matches mobile installers under the gen/<platform> tree", async () => {
    const root = bundleRoot(projectDir, bundleLayout("android"));
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

    const result = await collectArtifacts(projectDir, "android", outDir, bundleLayout("android"), {
      resolvePath
    });

    expect(result.artifacts).toEqual([path.join(outDir, "android", "app-release.apk")]);
  });

  it("refuses to collect into a symlinked delivery directory, removing nothing", async () => {
    const escapeTarget = await mkdtemp(path.join(tmpdir(), "moku-native-collect-escape-"));
    const bystander = path.join(escapeTarget, "keep-me");
    await writeFile(bystander, "bystander-bytes", "utf8");

    const dmgDir = path.join(bundleRoot(projectDir, bundleLayout("macos")), "bundle", "dmg");
    await mkdir(dmgDir, { recursive: true });
    await writeFile(path.join(dmgDir, "MyApp.dmg"), "dmg-bytes", "utf8");
    await symlink(escapeTarget, path.join(outDir, "macos"), "dir");

    try {
      await expect(
        collectArtifacts(projectDir, "macos", outDir, bundleLayout("macos"), { resolvePath })
      ).rejects.toThrow(/^\[native\] Refusing to collect/);
      expect(await readFile(bystander, "utf8")).toBe("bystander-bytes");
    } finally {
      await unlink(path.join(outDir, "macos"));
      await rm(escapeTarget, { recursive: true, force: true });
    }
  });

  it("throws a [native]-formatted error naming the globbed roots when nothing matches", async () => {
    await expect(
      collectArtifacts(projectDir, "macos", outDir, bundleLayout("macos"), { resolvePath })
    ).rejects.toThrow(
      /^\[native\] No macos installer artifacts found\.\n {2}Checked .*bundle\/dmg\/\*\.dmg.*bundle\/macos\/\*\.app/
    );
  });
});

describe("collectArtifacts — android artifact flavour", () => {
  let projectDir: string;
  let outDir: string;

  /** Seeds both an apk and an aab where `tauri android build` writes them. */
  const seedBoth = async (): Promise<void> => {
    const outputs = path.join(projectDir, "src-tauri", "gen", "android", "app", "build", "outputs");
    await mkdir(path.join(outputs, "apk", "universal", "release"), { recursive: true });
    await mkdir(path.join(outputs, "bundle", "universalRelease"), { recursive: true });
    await writeFile(path.join(outputs, "apk", "universal", "release", "app-release.apk"), "apk");
    await writeFile(path.join(outputs, "bundle", "universalRelease", "app-release.aab"), "aab");
  };

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-collect-android-project-"));
    outDir = await mkdtemp(path.join(tmpdir(), "moku-native-collect-android-out-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it("aab: collects the store bundle and never the apk", async () => {
    await seedBoth();

    const result = await collectArtifacts(projectDir, "android", outDir, bundleLayout("android"), {
      aab: true,
      resolvePath
    });

    expect(result.artifacts).toEqual([path.join(outDir, "android", "app-release.aab")]);
  });

  it("default: collects the apk and never the store bundle", async () => {
    await seedBoth();

    const result = await collectArtifacts(projectDir, "android", outDir, bundleLayout("android"), {
      resolvePath
    });

    expect(result.artifacts).toEqual([path.join(outDir, "android", "app-release.apk")]);
  });

  it("aab with nothing built: names the aab pattern in the [native] error", async () => {
    await expect(
      collectArtifacts(projectDir, "android", outDir, bundleLayout("android"), {
        aab: true,
        resolvePath
      })
    ).rejects.toThrow(/Checked .*outputs\/bundle\/.*\.aab/);
  });

  it("never collects a debug apk, only the release flavour", async () => {
    const outputs = path.join(projectDir, "src-tauri", "gen", "android", "app", "build", "outputs");
    await mkdir(path.join(outputs, "apk", "universal", "debug"), { recursive: true });
    await mkdir(path.join(outputs, "apk", "universal", "release"), { recursive: true });
    await writeFile(path.join(outputs, "apk", "universal", "debug", "app-debug.apk"), "debug");
    await writeFile(path.join(outputs, "apk", "universal", "release", "app-release.apk"), "apk");

    const result = await collectArtifacts(projectDir, "android", outDir, bundleLayout("android"), {
      resolvePath
    });

    expect(result.artifacts).toEqual([path.join(outDir, "android", "app-release.apk")]);
  });

  it("never collects a debug store bundle, only the release flavour", async () => {
    const outputs = path.join(projectDir, "src-tauri", "gen", "android", "app", "build", "outputs");
    await mkdir(path.join(outputs, "bundle", "universalDebug"), { recursive: true });
    await mkdir(path.join(outputs, "bundle", "universalRelease"), { recursive: true });
    await writeFile(path.join(outputs, "bundle", "universalDebug", "app-debug.aab"), "debug");
    await writeFile(path.join(outputs, "bundle", "universalRelease", "app-release.aab"), "aab");

    const result = await collectArtifacts(projectDir, "android", outDir, bundleLayout("android"), {
      aab: true,
      resolvePath
    });

    expect(result.artifacts).toEqual([path.join(outDir, "android", "app-release.aab")]);
  });
});

describe("collectArtifacts — iOS simulator vs device", () => {
  let projectDir: string;
  let outDir: string;

  /**
   * Seeds the simulator build output: a `.app` DIRECTORY whose name contains spaces, under
   * the arch directory tauri names after the `--target` it was given.
   */
  async function seedSimulatorApp(archDirectory = "arm64-sim"): Promise<string> {
    const appDir = path.join(
      bundleRoot(projectDir, bundleLayout("ios")),
      "gen",
      "apple",
      "build",
      archDirectory,
      "My Test App.app"
    );
    await mkdir(path.join(appDir, "Frameworks"), { recursive: true });
    await writeFile(path.join(appDir, "Info.plist"), "plist-bytes", "utf8");
    return appDir;
  }

  /** Seeds the device build output: a signed `.ipa` file. */
  async function seedDeviceIpa(): Promise<string> {
    const ipaDir = path.join(
      bundleRoot(projectDir, bundleLayout("ios")),
      "gen",
      "apple",
      "build",
      "arm64"
    );
    await mkdir(ipaDir, { recursive: true });
    const ipaPath = path.join(ipaDir, "My Test App.ipa");
    await writeFile(ipaPath, "ipa-bytes", "utf8");
    return ipaPath;
  }

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-collect-ios-project-"));
    outDir = await mkdtemp(path.join(tmpdir(), "moku-native-collect-ios-out-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  // Both simulator directory names tauri produces: `<arch>-sim` everywhere, and a bare
  // `x86_64` on an Intel host, where the simulator target carries no `-sim` suffix.
  it.each([
    "arm64-sim",
    "x86_64"
  ])("simulator: copies the %s/*.app directory recursively, spaces and all", async archDirectory => {
    await seedSimulatorApp(archDirectory);

    const result = await collectArtifacts(projectDir, "ios", outDir, bundleLayout("ios"), {
      simulator: true,
      resolvePath
    });

    const copiedApp = path.join(outDir, "ios", "My Test App.app");
    expect(result.artifacts).toEqual([copiedApp]);
    expect(await readFile(path.join(copiedApp, "Info.plist"), "utf8")).toBe("plist-bytes");
    expect(existsSync(path.join(copiedApp, "Frameworks"))).toBe(true);
  });

  it("simulator: never collects a device .ipa", async () => {
    await seedSimulatorApp();
    await seedDeviceIpa();

    const result = await collectArtifacts(projectDir, "ios", outDir, bundleLayout("ios"), {
      simulator: true,
      resolvePath
    });

    expect(result.artifacts.map(artifact => path.basename(artifact))).toEqual(["My Test App.app"]);
  });

  it("device: collects the .ipa and never the simulator .app", async () => {
    await seedSimulatorApp();
    await seedDeviceIpa();

    const result = await collectArtifacts(projectDir, "ios", outDir, bundleLayout("ios"), {
      resolvePath
    });

    expect(result.artifacts).toEqual([path.join(outDir, "ios", "My Test App.ipa")]);
  });

  /** Seeds a second arch directory carrying the same installer name. */
  async function seedSecondArchIpa(content: string): Promise<string> {
    const archDir = path.join(
      bundleRoot(projectDir, bundleLayout("ios")),
      "gen",
      "apple",
      "build",
      "x86_64"
    );
    await mkdir(archDir, { recursive: true });
    const ipaPath = path.join(archDir, "My Test App.ipa");
    await writeFile(ipaPath, content, "utf8");
    return ipaPath;
  }

  it("device: reports one artifact per name when stale arch directories repeat it", async () => {
    await seedDeviceIpa();
    await seedSecondArchIpa("stale-ipa-bytes");

    const result = await collectArtifacts(projectDir, "ios", outDir, bundleLayout("ios"), {
      resolvePath
    });

    expect(result.artifacts).toEqual([path.join(outDir, "ios", "My Test App.ipa")]);
  });

  it("device: ships the NEWEST build when a stale arch directory repeats the name", async () => {
    const fresh = await seedDeviceIpa();
    const stale = await seedSecondArchIpa("stale-ipa-bytes");
    await utimes(fresh, NEWER, NEWER);
    await utimes(stale, OLDER, OLDER);

    const result = await collectArtifacts(projectDir, "ios", outDir, bundleLayout("ios"), {
      resolvePath
    });

    expect(await readFile(result.artifacts[0] as string, "utf8")).toBe("ipa-bytes");
  });

  it("device: ships the newest build whichever directory the glob returns last", async () => {
    const stale = await seedDeviceIpa();
    const fresh = await seedSecondArchIpa("second-arch-bytes");
    await utimes(stale, OLDER, OLDER);
    await utimes(fresh, NEWER, NEWER);

    const result = await collectArtifacts(projectDir, "ios", outDir, bundleLayout("ios"), {
      resolvePath
    });

    expect(await readFile(result.artifacts[0] as string, "utf8")).toBe("second-arch-bytes");
  });

  it("simulator with nothing built: names both simulator patterns in the [native] error", async () => {
    // One rejection, asserted twice: the message must name BOTH simulator directory layouts.
    const message = await collectArtifacts(projectDir, "ios", outDir, bundleLayout("ios"), {
      simulator: true,
      resolvePath
    }).then(
      () => "collect unexpectedly succeeded",
      (error: Error) => error.message
    );

    expect(message).toMatch(
      /^\[native\] No ios installer artifacts found\.\n {2}Checked .*gen\/apple\/build\/\*-sim\/\*\.app/
    );
    expect(message).toMatch(/gen\/apple\/build\/x86_64\/\*\.app/);
  });
});
