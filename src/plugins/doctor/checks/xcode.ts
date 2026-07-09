/**
 * @file doctor plugin check — Xcode + xcodebuild + queryable simulators (ios; macOS host only).
 */
import process from "node:process";
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * Confirms Xcode's command-line tools are present and iOS simulators are queryable.
 *
 * @param input - The check input, scoped to the "ios" target.
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "ios", probe, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const xcodebuildResult = await input.probe("xcodebuild", ["-version"]);
  if (xcodebuildResult.code !== 0) {
    return {
      id: "xcode-toolchain",
      target: "ios",
      status: "fail",
      message: "[native] Xcode / xcodebuild was not found.",
      fixIt: "install Xcode from the App Store, then run `xcode-select --install`"
    };
  }

  const simulatorsResult = await input.probe("xcrun", ["simctl", "list", "devices"]);
  if (simulatorsResult.code !== 0) {
    return {
      id: "xcode-toolchain",
      target: "ios",
      status: "fail",
      message: "[native] Xcode is installed but iOS simulators are not queryable.",
      fixIt: "open Xcode once to finish installing simulator runtimes"
    };
  }

  return {
    id: "xcode-toolchain",
    target: "ios",
    status: "pass",
    message: "[native] Xcode / xcodebuild is present and simulators are queryable."
  };
}

/** Xcode toolchain presence — ios only, and only meaningful on a macOS host. */
export const xcodeCheck: Check = {
  id: "xcode-toolchain",
  /**
   * Whether this check applies — ios only, and only on a macOS host.
   *
   * @param target - The candidate scope.
   * @returns Whether `xcode-toolchain` applies to `target`.
   * @example
   * ```ts
   * xcodeCheck.appliesTo("ios", global); // true on a macOS host
   * ```
   */
  appliesTo: target => target === "ios" && process.platform === "darwin",
  run
};
