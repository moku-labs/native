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
  CLEAN_INFO_PLIST,
  DEBUG_INFO_PLIST,
  LITERAL_RUNNER,
  mainActivityPath,
  pbxprojFor,
  projectYmlFor,
  REAL_MAIN_ACTIVITY,
  REAL_PBXPROJ,
  REAL_PROJECT_YML,
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

  /** Seeds a gen/apple tree whose `<slug>_iOS/Info.plist` holds `content`. */
  const seedInfoPlist = async (content: string) => {
    const genDir = await seedApple();
    const infoPlist = path.join(genDir, "MyApp_iOS", "Info.plist");
    await mkdir(path.dirname(infoPlist), { recursive: true });
    await writeFile(infoPlist, content, "utf8");
    return { genDir, infoPlist };
  };

  /** Seeds a gen/apple tree with the real generated files, and a manifest source beside it. */
  const seedRealApple = async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    const projectYml = path.join(genDir, "project.yml");
    const pbxproj = path.join(genDir, "store-probe.xcodeproj", "project.pbxproj");
    const source = path.join(dir, "PrivacyInfo.source.xcprivacy");
    await mkdir(path.dirname(pbxproj), { recursive: true });
    await writeFile(projectYml, REAL_PROJECT_YML, "utf8");
    await writeFile(pbxproj, REAL_PBXPROJ, "utf8");
    await writeFile(source, "<plist/>\n", "utf8");
    return { projectYml, pbxproj, source, manifest: path.join(genDir, "PrivacyInfo.xcprivacy") };
  };

  /** An iOS pass with the given minimum and privacy manifest. */
  const patchIos = (iosMinimumSystemVersion?: string, privacyManifest?: string) =>
    patchMobile(
      dir,
      { target: "ios" },
      iosMinimumSystemVersion ? { apple: { iosMinimumSystemVersion } } : {},
      [],
      undefined,
      undefined,
      privacyManifest
    );

  it("ios moves a kept tree to the configured minimum and adds the manifest — one report (bug: MinimumOSVersion stays on the first init's value)", async () => {
    const { projectYml, pbxproj, source, manifest } = await seedRealApple();

    const result = await patchIos("26.0", source);

    expect(result.patched.toSorted()).toEqual([manifest, pbxproj, projectYml].toSorted());
    expect(result.unchanged).toEqual([]);
    expect(await readFile(projectYml, "utf8")).toContain("    iOS: 26.0\n");
    expect(await readFile(pbxproj, "utf8")).toContain("IPHONEOS_DEPLOYMENT_TARGET = 26.0;");
    expect(await readFile(manifest, "utf8")).toBe("<plist/>\n");
  });

  it("ios falls back to the default minimum (bug: a kept tree keeps whatever init wrote)", async () => {
    const { projectYml, pbxproj } = await seedRealApple();

    await patchIos();

    expect(await readFile(projectYml, "utf8")).toContain("    iOS: 15.0\n");
    expect(await readFile(pbxproj, "utf8")).toContain("IPHONEOS_DEPLOYMENT_TARGET = 15.0;");
  });

  it("a store pass with the option unset removes a stale manifest (bug: the bundle keeps declaring what the app dropped)", async () => {
    const { projectYml, pbxproj, source, manifest } = await seedRealApple();
    await patchIos("16.0", source);

    const result = await patchIos("16.0");

    expect(result.patched).toContain(manifest);
    expect(existsSync(manifest)).toBe(false);
    expect(await readFile(projectYml, "utf8")).toBe(REAL_PROJECT_YML);
    expect(await readFile(pbxproj, "utf8")).toBe(REAL_PBXPROJ);
  });

  it("a missing manifest source is refused before anything is written (bug: a half-patched tree)", async () => {
    const { projectYml, pbxproj, manifest } = await seedRealApple();
    const missing = path.join(dir, "gone.xcprivacy");
    // Fresh from init: the first patch of the pass has something to write here.
    const unpatched = REAL_PBXPROJ.replaceAll(
      "\t\t\t\tCODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION = YES;\n",
      ""
    );
    await writeFile(pbxproj, unpatched, "utf8");

    await expect(patchIos("26.0", missing)).rejects.toThrow(
      `[native] ios.privacyManifest "${missing}" was not found.`
    );
    expect(await readFile(projectYml, "utf8")).toBe(REAL_PROJECT_YML);
    expect(await readFile(pbxproj, "utf8")).toBe(unpatched);
    expect(existsSync(manifest)).toBe(false);
  });

  it("an iOS tree that was never initialised reports nothing, the option set or not (bug: the patch crashes the first build)", async () => {
    await expect(patchIos("26.0", path.join(dir, "gone.xcprivacy"))).resolves.toEqual({
      patched: [],
      unchanged: []
    });
    expect(existsSync(path.join(dir, "src-tauri"))).toBe(false);
  });

  it("android ignores the privacy manifest", async () => {
    const genDir = await seedAndroid();

    await patchMobile(dir, { target: "android" }, {}, [], undefined, undefined, "/nowhere.plist");

    expect(existsSync(path.join(genDir, "PrivacyInfo.xcprivacy"))).toBe(false);
  });

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

  it("android styles the status bar and the window background after the manifest and before the runner — one report", async () => {
    const genDir = await seedAndroid();
    const gradlePath = path.join(genDir, "app", "build.gradle.kts");
    const manifestPath = await seedAndroidManifest(genDir);
    const activityPath = mainActivityPath(genDir);
    await mkdir(path.dirname(activityPath), { recursive: true });
    await writeFile(activityPath, REAL_MAIN_ACTIVITY, "utf8");
    const valuesDir = path.join(genDir, "app", "src", "main", "res", "values");
    const themesPath = path.join(valuesDir, "themes.xml");
    const colourPath = path.join(valuesDir, "moku_window_background.xml");
    await mkdir(valuesDir, { recursive: true });
    await writeFile(
      themesPath,
      '<resources>\n    <style name="Theme.my_app" parent="P">\n    </style>\n</resources>\n',
      "utf8"
    );
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
      patched: [manifestPath, activityPath, colourPath, themesPath, taskPath],
      unchanged: [gradlePath]
    });
    expect(await readFile(activityPath, "utf8")).toContain("SystemBarStyle.dark(");
    expect(await readFile(themesPath, "utf8")).toContain(
      '<item name="android:windowBackground">@color/moku_window_background</item>'
    );
  });

  it("android fails with a fix-it when a colour meets a tree without MainActivity.kt", async () => {
    await seedAndroid();

    await expect(patchMobile(dir, { target: "android" }, {}, [], "#10161d")).rejects.toThrow(
      "[native] Could not find the MainActivity.kt that calls enableEdgeToEdge()"
    );
  });

  it("debug without the debug keystore fails with the keytool fix before writing (bug: an opaque Gradle failure)", async () => {
    const genDir = await seedAndroid();
    const missing = path.join(dir, "home", ".android", "debug.keystore");
    const debug = { profile: "debug" as const, appName: "My App", debugKeystore: missing };

    await expect(patchMobile(dir, { target: "android" }, {}, [], undefined, debug)).rejects.toThrow(
      `[native] debug keystore not found at ${missing}.\n  Create it with: mkdir -p "${path.dirname(missing)}" && keytool -genkeypair -v -keystore "${missing}"`
    );
    expect(await readFile(path.join(genDir, "app", "build.gradle.kts"), "utf8")).toBe(
      "plugins {}\n"
    );
  });

  it("ios ignores the background colour", async () => {
    await seedApple();

    const result = await patchMobile(dir, { target: "ios" }, {}, [], "#10161d");

    expect(result.patched).toEqual([]);
  });

  describe("the debug keys a kept Info.plist carries", () => {
    it.each([
      "store",
      "dev"
    ] as const)("a %s pass removes them and reports the file (bug: a tester's or store build ships the loosened ATS after a debug build)", async profile => {
      const { infoPlist } = await seedInfoPlist(DEBUG_INFO_PLIST);

      const result = await patchMobile(dir, { target: "ios", profile }, {});

      expect(await readFile(infoPlist, "utf8")).toBe(CLEAN_INFO_PLIST);
      expect(result.patched).toEqual([infoPlist]);
    });

    it("a second pass reports the file unchanged (bug: every store build rewrites it)", async () => {
      const { infoPlist } = await seedInfoPlist(DEBUG_INFO_PLIST);
      await patchMobile(dir, { target: "ios", profile: "store" }, {});

      const second = await patchMobile(dir, { target: "ios", profile: "store" }, {});

      expect(second.patched).toEqual([]);
      expect(second.unchanged).toContain(infoPlist);
    });

    it("a debug pass leaves them (bug: the Android profile stands in for the real one, and an iOS debug build loses its local network)", async () => {
      const { infoPlist } = await seedInfoPlist(DEBUG_INFO_PLIST);

      const result = await patchMobile(dir, { target: "ios", profile: "debug" }, {});

      expect(await readFile(infoPlist, "utf8")).toBe(DEBUG_INFO_PLIST);
      expect(result.patched).toEqual([]);
      expect(result.unchanged).not.toContain(infoPlist);
    });

    it("a <slug>_iOS directory without the file is nothing to do (bug: the first build, before tauri wrote it, crashes)", async () => {
      const genDir = await seedApple();
      await mkdir(path.join(genDir, "MyApp_iOS"));

      const result = await patchMobile(dir, { target: "ios", profile: "store" }, {});

      expect(result.unchanged).not.toContain(path.join(genDir, "MyApp_iOS", "Info.plist"));
      expect(existsSync(path.join(genDir, "MyApp_iOS", "Info.plist"))).toBe(false);
    });

    it("touches no Info.plist outside the <slug>_iOS directory (bug: another target's plist edited)", async () => {
      const { genDir } = await seedInfoPlist(CLEAN_INFO_PLIST);
      const other = path.join(genDir, "Widgets", "Info.plist");
      await mkdir(path.dirname(other));
      await writeFile(other, DEBUG_INFO_PLIST, "utf8");

      await patchMobile(dir, { target: "ios", profile: "store" }, {});

      expect(await readFile(other, "utf8")).toBe(DEBUG_INFO_PLIST);
    });
  });
});
