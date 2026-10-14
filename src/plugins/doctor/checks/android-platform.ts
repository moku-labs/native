/**
 * @file doctor plugin check — the installed Android SDK platform matches the tree's
 * `compileSdk` (`platforms/android-N` or `android-N.0`).
 */
import path from "node:path";
import process from "node:process";
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * The `compileSdk` the tauri-cli 2.11 Android template writes into `app/build.gradle.kts`.
 * Required when the `gen/android` tree is not generated yet (it will be, from that template).
 */
const TEMPLATE_COMPILE_SDK = 37;

/** The `compileSdk = 37` line of the generated `app/build.gradle.kts`. */
const COMPILE_SDK_LINE = /\bcompileSdk\s*=\s*(\d+)/;

/**
 * A platform directory that satisfies `compileSdk = N`: `android-37`, or the newer
 * minor-version naming of the same release, `android-37.0`. A real minor platform
 * (`android-36.1`) is a separate package and does not satisfy `compileSdk = 36`.
 */
const PLATFORM_DIRECTORY = /^android-(\d+)(?:\.0)?$/;

/**
 * Resolves the Android Studio default SDK location for this host: `~/Library/Android/sdk`
 * on macOS, `%LOCALAPPDATA%\Android\Sdk` on Windows, `~/Android/Sdk` elsewhere.
 *
 * @param input - The check input (home and `LOCALAPPDATA` come from its env).
 * @returns The default SDK root, or `undefined` when the env names no home to resolve it in.
 */
function defaultSdkRoot(input: CheckInput): string | undefined {
  if (process.platform === "win32") {
    const localAppData = input.env.get("LOCALAPPDATA");
    return localAppData === undefined ? undefined : path.join(localAppData, "Android", "Sdk");
  }
  // An empty HOME names no home: fall back to USERPROFILE, as project's keystore rule does.
  const home = input.env.get("HOME") || input.env.get("USERPROFILE") || undefined;
  if (home === undefined) return undefined;
  return process.platform === "darwin"
    ? path.join(home, "Library", "Android", "sdk")
    : path.join(home, "Android", "Sdk");
}

/**
 * Reads the API level the build compiles against: `compileSdk` from the generated
 * `<projectDir>/src-tauri/gen/android/app/build.gradle.kts`, else the template's level.
 *
 * @param input - The check input (reads through its fs facade).
 * @returns The required API level.
 */
async function requiredLevel(input: CheckInput): Promise<number> {
  const gradlePath = path.resolve(
    input.global.projectDir,
    "src-tauri",
    "gen",
    "android",
    "app",
    "build.gradle.kts"
  );
  const gradle = await input.fs.readFile(gradlePath).catch(() => "");
  const level = COMPILE_SDK_LINE.exec(gradle)?.[1];
  return level === undefined ? TEMPLATE_COMPILE_SDK : Number(level);
}

/**
 * The result for an SDK root that is not on disk. An env var naming a missing directory is a
 * `fail`: `android-toolchain` only sees that the var is set, so nothing else catches the
 * broken SDK before Gradle does. No env var and no SDK at the default location is a `warn`:
 * `android-toolchain` already fails for it, and one cause is one failure.
 *
 * @param input - The check input (tells which env var named the root).
 * @param configuredRoot - The SDK root `ANDROID_HOME`/`ANDROID_SDK_ROOT` named, if either is set.
 * @returns The `fail` or `warn` result.
 */
function missingSdkResult(input: CheckInput, configuredRoot: string | undefined): CheckResult {
  if (configuredRoot === undefined) {
    return {
      id: "android-platform",
      target: "android",
      status: "warn",
      message:
        "[native] no Android SDK was found, so its platforms cannot be checked (android-toolchain reports the SDK).",
      fixIt: "install the Android SDK with Android Studio, then set ANDROID_HOME"
    };
  }
  const variable =
    input.env.get("ANDROID_HOME") === undefined ? "ANDROID_SDK_ROOT" : "ANDROID_HOME";
  return {
    id: "android-platform",
    target: "android",
    status: "fail",
    message: `[native] ${variable} points to a missing directory: ${configuredRoot}.`,
    fixIt: `point ${variable} at the Android SDK (Android Studio: Settings → Android SDK → Android SDK Location)`
  };
}

/**
 * Confirms the SDK platform for the build's `compileSdk` is installed. An env var naming a
 * missing SDK fails; no SDK at all is a warning only (`android-toolchain` fails for it).
 *
 * @param input - The check input, scoped to the "android" target.
 * @returns The check result.
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const configuredRoot = input.env.get("ANDROID_HOME") ?? input.env.get("ANDROID_SDK_ROOT");
  const sdkRoot = configuredRoot ?? defaultSdkRoot(input);
  if (sdkRoot === undefined || !(await input.fs.exists(sdkRoot))) {
    return missingSdkResult(input, configuredRoot);
  }

  const level = await requiredLevel(input);
  const entries = await input.fs.readdir(path.join(sdkRoot, "platforms")).catch(() => []);
  const installed = entries.find(name => PLATFORM_DIRECTORY.exec(name)?.[1] === String(level));
  if (installed === undefined) {
    return {
      id: "android-platform",
      target: "android",
      status: "fail",
      message: `[native] Android SDK platform android-${level} is not installed (compileSdk ${level}).`,
      fixIt: `sdkmanager "platforms;android-${level}" (or Android Studio: SDK Manager → SDK Platforms → Android API ${level})`
    };
  }

  return {
    id: "android-platform",
    target: "android",
    status: "pass",
    message: `[native] Android SDK platform ${installed} is installed (compileSdk ${level}).`
  };
}

/** The installed Android SDK platform for the build's `compileSdk` — android only. */
export const androidPlatformCheck: Check = {
  id: "android-platform",
  /**
   * Whether this check applies — android only.
   *
   * @param target - The candidate scope.
   * @returns Whether `android-platform` applies to `target`.
   * @example
   * ```ts
   * androidPlatformCheck.appliesTo("android", global); // true
   * ```
   */
  appliesTo: target => target === "android",
  run
};
