/**
 * @file doctor plugin check — the installed Android SDK platform matches the tree's
 * `compileSdk` (`platforms/android-N` or `android-N.<minor>`).
 */
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * Runs the check for the android scope.
 *
 * @param _input - The assembled check input.
 * @example
 * ```ts
 * await run(input);
 * ```
 */
async function run(_input: CheckInput): Promise<CheckResult> {
  throw new Error("not implemented");
}

/** The `android-platform` check: android target only. */
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
