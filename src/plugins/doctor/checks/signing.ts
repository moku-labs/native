/**
 * @file doctor plugin check — signing readiness for ios/macos/android: env-var PRESENCE only
 * (never values) plus, for Apple, a count-only keychain identity probe (A14). Warn-only
 * posture: unsigned and simulator builds are legal, so this check never fails.
 */
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * The two Apple credential sets Tauri accepts (A14) — either one, complete, is enough.
 * Presence only: a value is never read, so nothing here can reach a message.
 */
const APPLE_CREDENTIAL_SETS: ReadonlyArray<{ label: string; vars: readonly string[] }> = [
  { label: "notarization", vars: ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"] },
  {
    label: "App Store Connect API key",
    vars: ["APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]
  }
];

/** Every Apple signing message repeats this — doctor never fails a build over signing. */
const LEGAL_NOTE = "unsigned and simulator builds are legal";

/**
 * Whether the local keychain is worth probing: only when a concrete `signingIdentity` is
 * configured (not the ad-hoc `"-"`) and CI has not brought its own certificate.
 *
 * @param input - The check input.
 * @returns Whether to run the keychain probe.
 * @example
 * ```ts
 * shouldProbeKeychain(input); // false when signing.apple.signingIdentity is unset
 * ```
 */
function shouldProbeKeychain(input: CheckInput): boolean {
  const identity = input.global.signing.apple?.signingIdentity;
  if (!identity || identity === "-") return false;
  return !input.env.has("APPLE_CERTIFICATE");
}

/**
 * Counts codesigning identities in the keychain. The COUNT only — the identity strings
 * themselves are never parsed out, so they can never reach a message or a log line.
 *
 * @param input - The check input (uses the injected probe seam).
 * @returns How many codesigning identities `security` listed (0 when the probe fails).
 * @example
 * ```ts
 * await countCodesigningIdentities(input); // 2
 * ```
 */
async function countCodesigningIdentities(input: CheckInput): Promise<number> {
  const result = await input.probe("security", ["find-identity", "-v", "-p", "codesigning"]);
  if (result.code !== 0) return 0;

  // Each listed identity is one `  <n>) <hash> "<name>"` line — only the line count is read.
  return result.stdout.split("\n").filter(line => /^\d+\)/.test(line.trim())).length;
}

/**
 * Checks Apple signing readiness for an ios/macos target: one complete credential set,
 * `signing.apple.teamId` for ios, and (when a signing identity is configured) at least one
 * codesigning identity in the keychain. Warn-only — every unmet condition still builds.
 *
 * @param input - The check input, scoped to "ios" or "macos".
 * @returns The check result — "pass" or "warn", never "fail".
 * @example
 * ```ts
 * await checkAppleSigning({ target: "macos", env, probe, ... });
 * ```
 */
async function checkAppleSigning(input: CheckInput): Promise<CheckResult> {
  const { target } = input;
  const id = `signing-${target}`;

  const satisfied = APPLE_CREDENTIAL_SETS.find(set => set.vars.every(name => input.env.has(name)));
  if (!satisfied) {
    const options = APPLE_CREDENTIAL_SETS.map(set => set.vars.join(" + ")).join(", or ");
    return {
      id,
      target,
      status: "warn",
      message: `[native] no complete Apple credential set is present for "${target}" — ${LEGAL_NOTE}.`,
      fixIt: `set ${options} to sign and notarize release builds`
    };
  }

  if (target === "ios" && !input.global.signing.apple?.teamId) {
    return {
      id,
      target,
      status: "warn",
      message: `[native] Apple credentials are present but signing.apple.teamId is not configured for "ios" — ${LEGAL_NOTE}.`,
      fixIt: "set signing.apple.teamId to your Apple Developer team id"
    };
  }

  if (!shouldProbeKeychain(input)) {
    return {
      id,
      target,
      status: "pass",
      message: `[native] Apple signing credentials are present for "${target}" (${satisfied.label}).`
    };
  }

  const identityCount = await countCodesigningIdentities(input);
  if (identityCount === 0) {
    return {
      id,
      target,
      status: "warn",
      message: `[native] no codesigning identity is available in the keychain for "${target}" — ${LEGAL_NOTE}.`,
      fixIt:
        "import your signing certificate into the login keychain, or set APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD in CI"
    };
  }
  return {
    id,
    target,
    status: "pass",
    message: `[native] Apple signing is configured for "${target}" (${satisfied.label}, ${identityCount} codesigning identities in the keychain).`
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

/** Signing readiness (presence and counts, never values) — ios/macos/android, warn-only. */
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
