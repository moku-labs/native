/**
 * @file doctor plugin check — rustup presence + the required rust target triple per Target.
 */
import type { Target } from "../../../config";
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/** Rust target triple required per packaging Target (`rustup target add <triple>`). */
const RUST_TARGET_TRIPLES: Readonly<Record<Target, string>> = {
  macos: "aarch64-apple-darwin",
  windows: "x86_64-pc-windows-msvc",
  linux: "x86_64-unknown-linux-gnu",
  ios: "aarch64-apple-ios",
  android: "aarch64-linux-android"
};

/**
 * Checks that rustup is on PATH and the packaging target's required rust triple is
 * installed, via `rustup target list --installed`.
 *
 * @param input - The check input for one real packaging target.
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "ios", probe, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const { target } = input;
  if (target === "host") {
    throw new Error('[native] rustup check invoked without a packaging target ("host").');
  }

  const triple = RUST_TARGET_TRIPLES[target];
  const probeResult = await input.probe("rustup", ["target", "list", "--installed"]);

  if (probeResult.code !== 0) {
    return {
      id: "rustup-targets",
      target,
      status: "fail",
      message: `[native] rustup was not found on PATH (required for "${target}").`,
      fixIt: "install rustup: https://rustup.rs"
    };
  }

  if (!probeResult.stdout.includes(triple)) {
    return {
      id: "rustup-targets",
      target,
      status: "fail",
      message: `[native] rust target "${triple}" is not installed (required for "${target}").`,
      fixIt: `rustup target add ${triple}`
    };
  }

  return {
    id: "rustup-targets",
    target,
    status: "pass",
    message: `[native] rustup target "${triple}" is installed.`
  };
}

/**
 * rustup presence + required rust target triple — applies to every real packaging target.
 * Membership in `RUST_TARGET_TRIPLES` (rather than a bare `!== "host"` check) keeps this
 * robust against an unrecognized target string reaching `appliesTo` at runtime.
 */
export const rustupCheck: Check = {
  id: "rustup-targets",
  /**
   * Whether this check applies — every real packaging target has a required rust triple.
   *
   * @param target - The candidate scope.
   * @returns Whether `rustup-targets` applies to `target`.
   * @example
   * ```ts
   * rustupCheck.appliesTo("ios", global); // true
   * ```
   */
  appliesTo: target => target in RUST_TARGET_TRIPLES,
  run
};
