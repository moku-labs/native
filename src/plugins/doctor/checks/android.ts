/**
 * @file doctor plugin check — ANDROID_HOME/SDK, NDK, and JDK presence (android).
 */
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * Confirms the Android SDK home, NDK home, and a real `java` binary are all present.
 *
 * @param input - The check input, scoped to the "android" target.
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "android", env, probe, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const missing: string[] = [];
  if (!input.env.has("ANDROID_HOME") && !input.env.has("ANDROID_SDK_ROOT")) {
    missing.push("ANDROID_HOME (or ANDROID_SDK_ROOT)");
  }
  if (!input.env.has("ANDROID_NDK_HOME")) {
    missing.push("ANDROID_NDK_HOME");
  }

  const javaResult = await input.probe("java", ["-version"]);
  if (javaResult.code !== 0) {
    missing.push("a working JDK (`java` on PATH)");
  }

  if (missing.length > 0) {
    return {
      id: "android-toolchain",
      target: "android",
      status: "fail",
      message: `[native] Android toolchain incomplete — missing: ${missing.join(", ")}.`,
      fixIt: "install Android Studio + NDK, then set ANDROID_HOME and ANDROID_NDK_HOME"
    };
  }

  return {
    id: "android-toolchain",
    target: "android",
    status: "pass",
    message: "[native] Android SDK, NDK, and JDK are all present."
  };
}

/** Android SDK/NDK/JDK presence — android only. */
export const androidCheck: Check = {
  id: "android-toolchain",
  /**
   * Whether this check applies — android only.
   *
   * @param target - The candidate scope.
   * @returns Whether `android-toolchain` applies to `target`.
   * @example
   * ```ts
   * androidCheck.appliesTo("android", global); // true
   * ```
   */
  appliesTo: target => target === "android",
  run
};
