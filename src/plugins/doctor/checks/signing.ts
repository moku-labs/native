/**
 * @file doctor plugin check — signing env-var PRESENCE only (never values) for ios/macos/android.
 * Warn-only posture: unsigned dev builds are legal, so this check never fails.
 */
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/** Apple signing env var names doctor checks for presence — values are never read into messages. */
const APPLE_SIGNING_ENV_VARS: readonly string[] = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];

/**
 * Checks Apple signing env var presence for an ios/macos target — every var, some, or none set.
 *
 * @param input - The check input, scoped to "ios" or "macos".
 * @returns The check result — "pass" or "warn", never "fail".
 * @example
 * ```ts
 * checkAppleSigning({ target: "macos", env, ... });
 * ```
 */
function checkAppleSigning(input: CheckInput): CheckResult {
  const { target } = input;
  const missing = APPLE_SIGNING_ENV_VARS.filter(name => !input.env.has(name));

  if (missing.length === APPLE_SIGNING_ENV_VARS.length) {
    return {
      id: `signing-${target}`,
      target,
      status: "warn",
      message: `[native] no Apple signing env vars are set for "${target}" — unsigned dev builds are legal.`,
      fixIt: `set ${APPLE_SIGNING_ENV_VARS.join(", ")} to sign release builds`
    };
  }
  if (missing.length > 0) {
    return {
      id: `signing-${target}`,
      target,
      status: "warn",
      message: `[native] Apple signing env vars partially set for "${target}" — missing: ${missing.join(", ")}.`,
      fixIt: `set ${missing.join(", ")} to complete Apple signing`
    };
  }
  return {
    id: `signing-${target}`,
    target,
    status: "pass",
    message: `[native] Apple signing env vars are set for "${target}".`
  };
}

/**
 * Checks the android signing env var (`signing.android.keystorePasswordEnv`) for presence.
 *
 * @param input - The check input, scoped to "android".
 * @returns The check result — "pass" or "warn", never "fail".
 * @example
 * ```ts
 * checkAndroidSigning({ target: "android", env, global, ... });
 * ```
 */
function checkAndroidSigning(input: CheckInput): CheckResult {
  const envName = input.global.signing.android?.keystorePasswordEnv;

  if (!envName) {
    return {
      id: "signing-android",
      target: "android",
      status: "warn",
      message: "[native] no android signing configured — unsigned dev builds are legal.",
      fixIt: "set signing.android.keystorePasswordEnv to sign release builds"
    };
  }
  if (!input.env.has(envName)) {
    return {
      id: "signing-android",
      target: "android",
      status: "warn",
      message: `[native] android signing env var "${envName}" is not set.`,
      fixIt: `export ${envName} before building a signed android release`
    };
  }
  return {
    id: "signing-android",
    target: "android",
    status: "pass",
    message: `[native] android signing env var "${envName}" is set.`
  };
}

/**
 * Dispatches to the Apple or Android signing presence check by target.
 *
 * @param input - The check input, scoped to "ios", "macos", or "android".
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "ios", env, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  if (input.target === "android") return checkAndroidSigning(input);
  if (input.target === "ios" || input.target === "macos") return checkAppleSigning(input);
  throw new Error(`[native] signing check does not apply to target "${input.target}".`);
}

/** Signing env-var presence (never values) — ios/macos/android, warn-only posture. */
export const signingCheck: Check = {
  id: "signing",
  /**
   * Whether this check applies — ios, macos, and android carry signing env var refs.
   *
   * @param target - The candidate scope.
   * @returns Whether `signing` applies to `target`.
   * @example
   * ```ts
   * signingCheck.appliesTo("android", global); // true
   * ```
   */
  appliesTo: target => target === "ios" || target === "macos" || target === "android",
  run
};
