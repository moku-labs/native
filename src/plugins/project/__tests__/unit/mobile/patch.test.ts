import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { patchMobile } from "../../../mobile/patch";
import { applySigningBlock } from "../../../mobile/signing";
import { orientationManifest } from "../../../orientation";
import {
  androidManifest,
  LITERAL_RUNNER,
  mainActivityPath,
  pbxprojFor,
  projectYmlFor,
  REAL_MAIN_ACTIVITY,
  RUNNER,
  SIGNING,
  SIGNING_BLOCK,
  screenOrientationLine,
  TEMPLATE_ACTIVITY_ATTRIBUTES,
  YML_RUNNER
} from "./fixtures";

/** Writes the template AndroidManifest.xml into a seeded gen/android tree. */
const seedAndroidManifest = async (genDir: string) => {
  const manifestPath = path.join(genDir, "app", "src", "main", "AndroidManifest.xml");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, androidManifest(), "utf8");
  return manifestPath;
};

describe("patchMobile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-patch-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Creates a minimal complete gen/android tree inside the temp projectDir. */
  const seedAndroid = async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "android");
    await mkdir(path.join(genDir, "app"), { recursive: true });
    await writeFile(path.join(genDir, "app", "build.gradle.kts"), "plugins {}\n", "utf8");
    return genDir;
  };

  /** Creates a minimal gen/apple tree carrying whichever runner Tauri detected. */
  const seedApple = async (runner = "node tauri") => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(path.join(genDir, "MyApp.xcodeproj"), { recursive: true });
    await writeFile(path.join(genDir, "project.yml"), projectYmlFor(runner), "utf8");
    await writeFile(
      path.join(genDir, "MyApp.xcodeproj", "project.pbxproj"),
      pbxprojFor(runner),
      "utf8"
    );
    return genDir;
  };

  it("skips the runner rewrite for ios when no runner is supplied", async () => {
    const genDir = await seedApple();

    const result = await patchMobile(dir, { target: "ios" }, {});

    // The Xcode-settings patch still runs; this fixture carries no settings block, so it
    // reports both generated files unchanged instead of rewriting the runner command.
    expect(result.patched).toEqual([]);
    expect(result.unchanged.toSorted()).toEqual(
      [
        path.join(genDir, "project.yml"),
        path.join(genDir, "MyApp.xcodeproj", "project.pbxproj")
      ].toSorted()
    );
    expect(await readFile(path.join(genDir, "project.yml"), "utf8")).toContain("node tauri");
  });

  it("adds the entitlements-modification setting to every buildSettings block", async () => {
    const genDir = await seedApple();
    const pbxprojPath = path.join(genDir, "MyApp.xcodeproj", "project.pbxproj");
    const withSettings = [
      pbxprojFor("node tauri"),
      "\t\t2551BCC2 /* release */ = {",
      "\t\t\tbuildSettings = {",
      "\t\t\t\tENABLE_BITCODE = NO;",
      "\t\t\t};",
      "\t\t};",
      ""
    ].join("\n");
    await writeFile(pbxprojPath, withSettings, "utf8");

    const first = await patchMobile(dir, { target: "ios", runner: RUNNER }, {});

    expect(first.patched).toContain(pbxprojPath);
    // One file, patched by both iOS passes — reported once, and never as "unchanged".
    expect(first.unchanged).not.toContain(pbxprojPath);
    const patched = await readFile(pbxprojPath, "utf8");
    expect(patched).toContain("\t\t\t\tCODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION = YES;");
    expect(patched).toContain(`shellScript = "${LITERAL_RUNNER} ios xcode-script`);

    const second = await patchMobile(dir, { target: "ios", runner: RUNNER }, {});

    expect(second.patched).toEqual([]);
    expect(second.unchanged).toContain(pbxprojPath);
  });

  it("is a no-op for ios when the gen/ tree has not been initialized yet", async () => {
    const result = await patchMobile(dir, { target: "ios", runner: RUNNER }, {});
    expect(result).toEqual({ patched: [], unchanged: [] });
  });

  it("throws when the android gen/ tree is missing", async () => {
    await expect(patchMobile(dir, { target: "android" }, {})).rejects.toThrow(
      "[native] Android gen/ tree not found or incomplete"
    );
  });

  it("writes the signing block into build.gradle.kts and never a keystore.properties", async () => {
    const genDir = await seedAndroid();
    const gradlePath = path.join(genDir, "app", "build.gradle.kts");

    const first = await patchMobile(dir, { target: "android" }, { android: SIGNING });
    expect(first.patched).toEqual([gradlePath]);
    expect(existsSync(path.join(genDir, "keystore.properties"))).toBe(false);
    expect(await readFile(gradlePath, "utf8")).toBe(`plugins {}\n\n${SIGNING_BLOCK}\n`);

    const second = await patchMobile(dir, { target: "android" }, { android: SIGNING });
    expect(second.patched).toEqual([]);
    expect(second.unchanged).toEqual([gradlePath]);
  });

  it("removes the signing block and a legacy keystore.properties when unconfigured", async () => {
    const genDir = await seedAndroid();
    const gradlePath = path.join(genDir, "app", "build.gradle.kts");
    const keystorePropertiesPath = path.join(genDir, "keystore.properties");
    await writeFile(gradlePath, applySigningBlock("plugins {}\n", SIGNING), "utf8");
    await writeFile(keystorePropertiesPath, "storeFile=release.jks\n", "utf8");

    const result = await patchMobile(dir, { target: "android" }, {});

    expect(await readFile(gradlePath, "utf8")).toBe("plugins {}\n");
    expect(existsSync(keystorePropertiesPath)).toBe(false);
    expect(result.patched).toContain(keystorePropertiesPath);
  });

  it("rewrites the iOS runner command in project.yml and every project.pbxproj", async () => {
    const genDir = await seedApple();

    const result = await patchMobile(dir, { target: "ios", runner: RUNNER }, {});

    expect(result.patched.toSorted()).toEqual(
      [
        path.join(genDir, "project.yml"),
        path.join(genDir, "MyApp.xcodeproj", "project.pbxproj")
      ].toSorted()
    );

    const projectYml = await readFile(path.join(genDir, "project.yml"), "utf8");
    expect(projectYml).toContain(
      '- script: "/opt/node v20/bin/node" "/repo/node modules/@tauri-apps/cli/tauri.js" ios xcode-script -v'
    );
    expect(projectYml).not.toContain("node tauri ios xcode-script");

    const pbxproj = await readFile(path.join(genDir, "MyApp.xcodeproj", "project.pbxproj"), "utf8");
    expect(pbxproj).toContain(
      String.raw`shellScript = "\"/opt/node v20/bin/node\" \"/repo/node modules/@tauri-apps/cli/tauri.js\" ios xcode-script -v`
    );
    expect(pbxproj).not.toContain("node tauri ios xcode-script");
  });

  it("rewrites a `bun tauri` runner Tauri baked in under `bun run`", async () => {
    const genDir = await seedApple("bun tauri");

    const result = await patchMobile(dir, { target: "ios", runner: RUNNER }, {});

    expect(result.patched).toHaveLength(2);
    expect(await readFile(path.join(genDir, "project.yml"), "utf8")).toBe(
      projectYmlFor(YML_RUNNER)
    );
    expect(await readFile(path.join(genDir, "MyApp.xcodeproj", "project.pbxproj"), "utf8")).toBe(
      pbxprojFor(LITERAL_RUNNER)
    );
  });

  it("is idempotent — a second iOS runner pass reports everything unchanged", async () => {
    const genDir = await seedApple();
    await patchMobile(dir, { target: "ios", runner: RUNNER }, {});

    const second = await patchMobile(dir, { target: "ios", runner: RUNNER }, {});

    expect(second.patched).toEqual([]);
    expect(second.unchanged.toSorted()).toEqual(
      [
        path.join(genDir, "project.yml"),
        path.join(genDir, "MyApp.xcodeproj", "project.pbxproj")
      ].toSorted()
    );
  });

  it("runs both the signing and the runner patch for android when a runner is supplied", async () => {
    const genDir = await seedAndroid();
    const buildSrcDir = path.join(genDir, "buildSrc", "src", "main", "java");
    await mkdir(buildSrcDir, { recursive: true });
    const taskPath = path.join(buildSrcDir, "BuildTask.kt");
    await writeFile(taskPath, 'val command = "node tauri android android-studio-script"\n', "utf8");

    const result = await patchMobile(
      dir,
      { target: "android", runner: RUNNER },
      {
        android: SIGNING
      }
    );

    expect(result.patched).toContain(path.join(genDir, "app", "build.gradle.kts"));
    expect(result.patched).toContain(taskPath);
    expect(await readFile(taskPath, "utf8")).toBe(
      `val command = "${LITERAL_RUNNER} android android-studio-script"\n`
    );
  });

  it("android runs signing, then the manifest patch, then the runner patch — one report", async () => {
    const genDir = await seedAndroid();
    const gradlePath = path.join(genDir, "app", "build.gradle.kts");
    const manifestPath = await seedAndroidManifest(genDir);
    const buildSrcDir = path.join(genDir, "buildSrc", "src", "main", "java");
    await mkdir(buildSrcDir, { recursive: true });
    const taskPath = path.join(buildSrcDir, "BuildTask.kt");
    await writeFile(taskPath, 'val command = "node tauri android android-studio-script"\n', "utf8");
    const portrait = orientationManifest("portrait");

    const first = await patchMobile(
      dir,
      { target: "android", runner: RUNNER },
      { android: SIGNING },
      portrait
    );

    expect(first).toEqual({ patched: [gradlePath, manifestPath, taskPath], unchanged: [] });
    expect(await readFile(manifestPath, "utf8")).toBe(
      androidManifest([screenOrientationLine("portrait"), ...TEMPLATE_ACTIVITY_ATTRIBUTES])
    );

    const second = await patchMobile(
      dir,
      { target: "android", runner: RUNNER },
      { android: SIGNING },
      portrait
    );

    expect(second).toEqual({ patched: [], unchanged: [gradlePath, manifestPath, taskPath] });
  });

  it("android still patches the manifest when no runner is supplied", async () => {
    const genDir = await seedAndroid();
    const manifestPath = await seedAndroidManifest(genDir);

    const result = await patchMobile(
      dir,
      { target: "android" },
      {},
      orientationManifest("landscape")
    );

    expect(result).toEqual({
      patched: [manifestPath],
      unchanged: [path.join(genDir, "app", "build.gradle.kts")]
    });
    expect(await readFile(manifestPath, "utf8")).toContain(
      screenOrientationLine("sensorLandscape")
    );
  });

  it("android fails with a fix-it when manifest entries meet a missing manifest", async () => {
    await seedAndroid();

    await expect(
      patchMobile(dir, { target: "android" }, {}, orientationManifest("portrait"))
    ).rejects.toThrow("[native] AndroidManifest.xml not found at");
  });

  it("ios ignores manifest entries", async () => {
    const genDir = await seedApple();

    const result = await patchMobile(dir, { target: "ios" }, {}, orientationManifest("portrait"));

    expect(result.patched).toEqual([]);
    expect(existsSync(path.join(genDir, "app"))).toBe(false);
  });

  it("android styles the status bar after the manifest and before the runner — one report", async () => {
    const genDir = await seedAndroid();
    const gradlePath = path.join(genDir, "app", "build.gradle.kts");
    const manifestPath = await seedAndroidManifest(genDir);
    const activityPath = mainActivityPath(genDir);
    await mkdir(path.dirname(activityPath), { recursive: true });
    await writeFile(activityPath, REAL_MAIN_ACTIVITY, "utf8");
    const buildSrcDir = path.join(genDir, "buildSrc", "src", "main", "java");
    await mkdir(buildSrcDir, { recursive: true });
    const taskPath = path.join(buildSrcDir, "BuildTask.kt");
    await writeFile(taskPath, 'val command = "node tauri android android-studio-script"\n', "utf8");
    const portrait = orientationManifest("portrait");

    const result = await patchMobile(
      dir,
      { target: "android", runner: RUNNER },
      {},
      portrait,
      "#10161d"
    );

    expect(result).toEqual({
      patched: [manifestPath, activityPath, taskPath],
      unchanged: [gradlePath]
    });
    expect(await readFile(activityPath, "utf8")).toContain("SystemBarStyle.dark(");
  });

  it("android fails with a fix-it when a colour meets a tree without MainActivity.kt", async () => {
    await seedAndroid();

    await expect(patchMobile(dir, { target: "android" }, {}, [], "#10161d")).rejects.toThrow(
      "[native] Could not find the MainActivity.kt that calls enableEdgeToEdge()"
    );
  });

  it("ios ignores the background colour", async () => {
    await seedApple();

    const result = await patchMobile(dir, { target: "ios" }, {}, [], "#10161d");

    expect(result.patched).toEqual([]);
  });
});
