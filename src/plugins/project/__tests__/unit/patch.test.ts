import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySigningBlock, patchMobile } from "../../patch";

// Env-var NAME references, never secrets (the SigningConfig invariant).
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- an env-var *name*, never a secret
const STORE_PASSWORD_ENV = "KS_PASSWORD";
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- an env-var *name*, never a secret
const KEY_PASSWORD_ENV = "KS_KEY_PASSWORD";

const RUNNER = {
  nodePath: "/opt/node v20/bin/node",
  tauriJsPath: "/repo/node modules/@tauri-apps/cli/tauri.js"
};

const SIGNING_BLOCK = [
  "// MOKU-SIGNING-START",
  "android {",
  "  signingConfigs {",
  '    maybeCreate("release").apply {',
  '      storeFile = file("release.jks")',
  '      keyAlias = "release"',
  `      storePassword = System.getenv("${STORE_PASSWORD_ENV}")`,
  `      keyPassword = System.getenv("${STORE_PASSWORD_ENV}")`,
  "    }",
  "  }",
  "  buildTypes {",
  '    getByName("release") {',
  '      signingConfig = signingConfigs.getByName("release")',
  "    }",
  "  }",
  "}",
  "// MOKU-SIGNING-END"
].join("\n");

const PROJECT_YML = [
  "targets:",
  "  MyApp_iOS:",
  "    scheme:",
  "      preActions:",
  "        - script: node tauri ios xcode-script -v --platform $PLATFORM_DISPLAY_NAME",
  "          name: Build Rust Code",
  ""
].join("\n");

const PBXPROJ = [
  "/* Begin PBXShellScriptBuildPhase section */",
  '\t\tshellScript = "node tauri ios xcode-script -v --platform $PLATFORM_DISPLAY_NAME";',
  "/* End PBXShellScriptBuildPhase section */",
  ""
].join("\n");

describe("applySigningBlock", () => {
  const signing = {
    keystorePath: "release.jks",
    keyAlias: "release",
    keystorePasswordEnv: STORE_PASSWORD_ENV
  };

  it("appends the exact Gradle signing block when none is present", () => {
    expect(applySigningBlock("plugins {}\n", signing)).toBe(`plugins {}\n\n${SIGNING_BLOCK}\n`);
  });

  it("reads the key password from keyPasswordEnv when it is set", () => {
    const patched = applySigningBlock("plugins {}\n", {
      ...signing,
      keyPasswordEnv: KEY_PASSWORD_ENV
    });
    expect(patched).toContain(`storePassword = System.getenv("${STORE_PASSWORD_ENV}")`);
    expect(patched).toContain(`keyPassword = System.getenv("${KEY_PASSWORD_ENV}")`);
  });

  it("is idempotent — re-applying produces the same content", () => {
    const once = applySigningBlock("plugins {}\n", signing);
    expect(applySigningBlock(once, signing)).toBe(once);
  });

  it("replaces a stale block rather than appending a second one", () => {
    const stale = applySigningBlock("plugins {}\n", { ...signing, keyAlias: "old-alias" });
    const refreshed = applySigningBlock(stale, signing);

    expect(refreshed.match(/MOKU-SIGNING-START/g)).toHaveLength(1);
    expect(refreshed).toContain('keyAlias = "release"');
    expect(refreshed).not.toContain('keyAlias = "old-alias"');
  });

  it("removes an existing block when no keystorePath is configured", () => {
    const patched = applySigningBlock("plugins {}\n", signing);
    expect(applySigningBlock(patched, {})).toBe("plugins {}\n");
  });

  it("leaves unpatched content alone when no keystorePath is configured", () => {
    expect(applySigningBlock("plugins {}\n", {})).toBe("plugins {}\n");
  });
});

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

  /** Creates a minimal gen/apple tree carrying Tauri's broken `node tauri` runner command. */
  const seedApple = async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(path.join(genDir, "MyApp.xcodeproj"), { recursive: true });
    await writeFile(path.join(genDir, "project.yml"), PROJECT_YML, "utf8");
    await writeFile(path.join(genDir, "MyApp.xcodeproj", "project.pbxproj"), PBXPROJ, "utf8");
    return genDir;
  };

  it("is a no-op for ios when no runner is supplied", async () => {
    await seedApple();
    const result = await patchMobile(dir, { target: "ios" }, {});
    expect(result).toEqual({ patched: [], unchanged: [] });
  });

  it("throws when the android gen/ tree is missing", async () => {
    await expect(patchMobile(dir, { target: "android" }, {})).rejects.toThrow(
      "[native] Android gen/ tree not found or incomplete"
    );
  });

  it("writes the signing block into build.gradle.kts and never a keystore.properties", async () => {
    const genDir = await seedAndroid();
    const signing = {
      android: {
        keystorePath: "release.jks",
        keyAlias: "release",
        keystorePasswordEnv: STORE_PASSWORD_ENV
      }
    };
    const gradlePath = path.join(genDir, "app", "build.gradle.kts");

    const first = await patchMobile(dir, { target: "android" }, signing);
    expect(first.patched).toEqual([gradlePath]);
    expect(existsSync(path.join(genDir, "keystore.properties"))).toBe(false);
    expect(await readFile(gradlePath, "utf8")).toBe(`plugins {}\n\n${SIGNING_BLOCK}\n`);

    const second = await patchMobile(dir, { target: "android" }, signing);
    expect(second.patched).toEqual([]);
    expect(second.unchanged).toEqual([gradlePath]);
  });

  it("removes the signing block and a legacy keystore.properties when unconfigured", async () => {
    const genDir = await seedAndroid();
    const gradlePath = path.join(genDir, "app", "build.gradle.kts");
    const keystorePropertiesPath = path.join(genDir, "keystore.properties");
    await writeFile(
      gradlePath,
      applySigningBlock("plugins {}\n", {
        keystorePath: "release.jks",
        keyAlias: "release",
        keystorePasswordEnv: STORE_PASSWORD_ENV
      }),
      "utf8"
    );
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

  it("rewrites the Android studio-script runner command in buildSrc sources", async () => {
    const genDir = await seedAndroid();
    const buildSrcDir = path.join(genDir, "buildSrc", "src", "main", "java");
    await mkdir(buildSrcDir, { recursive: true });
    const taskPath = path.join(buildSrcDir, "BuildTask.kt");
    await writeFile(taskPath, 'val command = "node tauri android android-studio-script"\n', "utf8");

    const result = await patchMobile(dir, { target: "android", runner: RUNNER }, {});

    expect(result.patched).toContain(taskPath);
    const expected = String.raw`val command = "\"/opt/node v20/bin/node\" \"/repo/node modules/@tauri-apps/cli/tauri.js\" android android-studio-script"`;
    expect(await readFile(taskPath, "utf8")).toBe(`${expected}\n`);
  });
});
