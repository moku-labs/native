import path from "node:path";
import { describe, expect, it } from "vitest";
import { androidPlatformCheck } from "../../../checks/android-platform";
import type { FakeTree } from "./fixtures";
import { baseGlobalConfig, createCheckInput, createEnv, createFs } from "./fixtures";

/** The SDK root every test points ANDROID_HOME at. */
const SDK = path.join("/opt", "android-sdk");

/** Where the generated tree declares its `compileSdk`. */
const GRADLE = path.resolve(
  baseGlobalConfig.projectDir,
  "src-tauri",
  "gen",
  "android",
  "app",
  "build.gradle.kts"
);

/**
 * Builds an android-scoped input over an SDK at {@link SDK} with the given platform dirs.
 *
 * @param platforms - The entries of `<sdk>/platforms`, or `undefined` for no such directory.
 * @param files - Extra files in the tree (the generated gradle file).
 * @returns The check input.
 */
function sdkWith(platforms: readonly string[] | undefined, files: FakeTree["files"] = {}) {
  const directories: Record<string, readonly string[]> = { [SDK]: ["platforms"] };
  if (platforms) directories[path.join(SDK, "platforms")] = platforms;
  return createCheckInput({
    target: "android",
    env: createEnv({ ANDROID_HOME: SDK }),
    fs: createFs({ directories, files })
  });
}

/**
 * Runs `fn` with `process.platform` overridden, restoring it after `fn` settles.
 *
 * @param platform - The host platform to pretend.
 * @param fn - The async work to run under it.
 * @returns Whatever `fn` resolves with.
 */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

describe("androidPlatformCheck.appliesTo", () => {
  it("applies to android only", () => {
    const { global } = createCheckInput();
    expect(androidPlatformCheck.appliesTo("android", global)).toBe(true);
    expect(androidPlatformCheck.appliesTo("ios", global)).toBe(false);
    expect(androidPlatformCheck.appliesTo("host", global)).toBe(false);
  });
});

describe("androidPlatformCheck.run", () => {
  it("passes when platforms/android-37 is installed and no tree is generated yet", async () => {
    const result = await androidPlatformCheck.run(sdkWith(["android-37"]));

    expect(result).toMatchObject({ id: "android-platform", target: "android", status: "pass" });
  });

  it("passes on the minor-version naming android-37.0 (bug: reported missing)", async () => {
    const result = await androidPlatformCheck.run(sdkWith(["android-36", "android-37.0"]));

    expect(result.status).toBe("pass");
    expect(result.message).toContain("android-37.0");
  });

  it("fails with the sdkmanager fix-it when only android-36 is installed (bug: Gradle fails late)", async () => {
    const result = await androidPlatformCheck.run(sdkWith(["android-36", "android-370"]));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("android-37 is not installed");
    expect(result.fixIt).toContain('sdkmanager "platforms;android-37"');
  });

  it("fails, not throws, when the SDK has no platforms directory at all", async () => {
    const result = await androidPlatformCheck.run(sdkWith(undefined));

    expect(result.status).toBe("fail");
  });

  it("requires the level the generated gradle names (bug: a hard-coded level drifts)", async () => {
    const gradle = 'android {\n    compileSdk = 38\n    namespace = "com.example"\n}\n';

    const result = await androidPlatformCheck.run(sdkWith(["android-37"], { [GRADLE]: gradle }));

    expect(result.status).toBe("fail");
    expect(result.fixIt).toContain('sdkmanager "platforms;android-38"');
  });

  it("warns, not fails, when no env var names an SDK and none is at the default (bug: two failures for one cause)", async () => {
    const noHome = createCheckInput({ target: "android", env: createEnv() });
    const noDefaultSdk = createCheckInput({
      target: "android",
      env: createEnv({ HOME: "/home/me" })
    });

    const results = await Promise.all([
      androidPlatformCheck.run(noHome),
      androidPlatformCheck.run(noDefaultSdk)
    ]);

    expect(results.map(result => result.status)).toEqual(["warn", "warn"]);
  });

  it("fails when ANDROID_HOME points to a missing directory (bug: broken SDK passes doctor, Gradle fails late)", async () => {
    const input = createCheckInput({
      target: "android",
      env: createEnv({ ANDROID_HOME: SDK, HOME: "/home/me" })
    });

    const result = await androidPlatformCheck.run(input);

    expect(result.status).toBe("fail");
    expect(result.message).toContain(`ANDROID_HOME points to a missing directory: ${SDK}`);
  });

  it("does not accept a minor platform android-36.1 for compileSdk 36 (bug: a separate package passes)", async () => {
    const gradle = "android {\n    compileSdk = 36\n}\n";

    const result = await androidPlatformCheck.run(sdkWith(["android-36.1"], { [GRADLE]: gradle }));

    expect(result.status).toBe("fail");
    expect(result.fixIt).toContain('sdkmanager "platforms;android-36"');
  });

  it.each([
    {
      platform: "darwin",
      env: { HOME: "/Users/me" },
      root: path.join("/Users/me", "Library", "Android", "sdk")
    },
    { platform: "linux", env: { HOME: "/home/me" }, root: path.join("/home/me", "Android", "Sdk") },
    {
      platform: "win32",
      env: {
        USERPROFILE: String.raw`C:\Users\me`,
        LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local`
      },
      root: path.join(String.raw`C:\Users\me\AppData\Local`, "Android", "Sdk")
    }
  ] as const)("finds the Android Studio default SDK on $platform when ANDROID_HOME is unset", async ({
    platform,
    env,
    root
  }) => {
    const fs = createFs({
      directories: { [root]: [], [path.join(root, "platforms")]: ["android-37"] }
    });
    const input = createCheckInput({ target: "android", env: createEnv(env), fs });

    const result = await withPlatform(platform, () => androidPlatformCheck.run(input));

    expect(result.status).toBe("pass");
  });

  it("falls back to USERPROFILE when HOME is set but empty (bug: `??` keeps the empty HOME)", async () => {
    const root = path.join("/home/me", "Android", "Sdk");
    const fs = createFs({
      directories: { [root]: [], [path.join(root, "platforms")]: ["android-37"] }
    });
    const input = createCheckInput({
      target: "android",
      env: createEnv({ HOME: "", USERPROFILE: "/home/me" }),
      fs
    });

    const result = await withPlatform("linux", () => androidPlatformCheck.run(input));

    expect(result.status).toBe("pass");
  });
});
