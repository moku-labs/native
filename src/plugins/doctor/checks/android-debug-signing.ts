/**
 * @file doctor plugin check — the Android debug keystore a debug build is signed with.
 * Missing is a warning: a store build does not need it.
 */
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/** How a signed debug build reaches a device — the pass message names both ways. */
const INSTALL_STEPS =
  "install a debug build over a cable with `adb install -r <apk>`, or over Wi-Fi (Android 11+) with `adb pair <ip>:<pair-port>` then `adb connect <ip>:<port>`";

/**
 * Looks for the debug keystore the project plugin signs debug builds with
 * (`project.getDebugKeystore()` — one home rule for doctor and the build). Warn-only: a
 * store build signs with its own keystore. Doctor only reports the create command; it never
 * runs it.
 *
 * @param input - The check input, scoped to the "android" target.
 * @returns The check result — "pass" or "warn", never "fail".
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const keystore = input.project.getDebugKeystore();

  if (keystore.path === undefined || !(await input.fs.exists(keystore.path))) {
    const location = keystore.path ?? "~/.android/debug.keystore";
    return {
      id: "android-debug-signing",
      target: "android",
      status: "warn",
      message: `[native] no Android debug keystore at ${location}, so debug builds cannot be signed (a store build does not need it).`,
      fixIt: keystore.createCommand
    };
  }

  return {
    id: "android-debug-signing",
    target: "android",
    status: "pass",
    message: `[native] Android debug keystore found at ${keystore.path}; ${INSTALL_STEPS}.`
  };
}

/** The Android debug keystore — android only, warn-only. */
export const androidDebugSigningCheck: Check = {
  id: "android-debug-signing",
  /**
   * Whether this check applies — android only.
   *
   * @param target - The candidate scope.
   * @returns Whether `android-debug-signing` applies to `target`.
   * @example
   * ```ts
   * androidDebugSigningCheck.appliesTo("android", global); // true
   * ```
   */
  appliesTo: target => target === "android",
  run
};
