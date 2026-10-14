/**
 * @file doctor plugin check — the Android debug keystore a debug build is signed with.
 * Missing is a warning: a store build does not need it.
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

/** The `android-debug-signing` check: android target only. */
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
