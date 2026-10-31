/**
 * @file doctor plugin check — signing readiness for ios/macos/android: env-var PRESENCE only
 * (never values) plus, for Apple, a count-only keychain identity probe and, for Android,
 * whether the keystore file exists. Warn-only posture: unsigned and simulator builds are
 * legal, so this check never fails.
 */
import path from "node:path";
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * The two Apple credential sets Tauri accepts — either one, complete, is enough.
 * Presence only: a value is never read, so nothing here can reach a message.
 */
const APPLE_CREDENTIAL_SETS: ReadonlyArray<{ label: string; vars: readonly string[] }> = [
  { label: "notarization", vars: ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"] },
  {
    label: "App Store Connect API key",
    vars: ["APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]
  }
];

/** Every signing message repeats this — doctor never fails a build over signing. */
const LEGAL_NOTE = "unsigned and simulator builds are legal";

/**
 * The Gradle module that holds the signing config, relative to `projectDir`. Gradle's
 * `file()` in `app/build.gradle.kts` resolves a relative `storeFile` from this directory.
 */
const GRADLE_APP_DIRECTORY = "src-tauri/gen/android/app";

/**
 * Whether the local keychain is worth probing: only when a concrete `signingIdentity` is
 * configured (not the ad-hoc `"-"`) and CI has not brought its own certificate.
 *
 * @param input - The check input.
 * @returns Whether to run the keychain probe.
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
 * Looks up the configured `signing.android.keystorePath` where Gradle will read it: an
 * absolute path as it stands, a relative one under {@link GRADLE_APP_DIRECTORY}.
 *
 * @param input - The check input (looks through its fs facade).
 * @returns The path that is missing, or `undefined` when none is configured or the file exists.
 */
async function missingKeystore(input: CheckInput): Promise<string | undefined> {
  const configured = input.global.signing.android?.keystorePath;
  if (!configured) return undefined;

  const keystore = path.isAbsolute(configured)
    ? configured
    : path.join(input.global.projectDir, GRADLE_APP_DIRECTORY, configured);
  return (await input.fs.exists(keystore)) ? undefined : keystore;
}

/**
 * Checks android signing: the `signing.android.keystorePasswordEnv` var, then the
 * `signing.android.keyPasswordEnv` var when one is configured (presence only), then the
 * `signing.android.keystorePath` file when one is configured. The first gap is the result.
 *
 * @param input - The check input, scoped to "android".
 * @returns The check result — "pass" or "warn", never "fail".
 */
async function checkAndroidSigning(input: CheckInput): Promise<CheckResult> {
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

  const keyPasswordVariable = input.global.signing.android?.keyPasswordEnv;
  if (keyPasswordVariable && !input.env.has(keyPasswordVariable)) {
    return {
      id: "signing-android",
      target: "android",
      status: "warn",
      message: `[native] android key password env var "${keyPasswordVariable}" is not set.`,
      fixIt: `export ${keyPasswordVariable} before building a signed android release`
    };
  }

  const keystore = await missingKeystore(input);
  if (keystore !== undefined) {
    return {
      id: "signing-android",
      target: "android",
      status: "warn",
      message: `[native] android keystore not found at ${keystore}.`,
      fixIt: `put the keystore at ${keystore}, or correct signing.android.keystorePath (a relative path resolves from ${GRADLE_APP_DIRECTORY})`
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
 * Checks the windows signing identifier: Tauri signs with the certificate whose thumbprint
 * is in `signing.windows.certificateThumbprint`, and reads the password from the
 * environment itself. Warn-only — an unsigned Windows installer still builds and installs.
 *
 * @param input - The check input, scoped to "windows".
 * @returns The check result — "pass" or "warn", never "fail".
 */
function checkWindowsSigning(input: CheckInput): CheckResult {
  const thumbprint = input.global.signing.windows?.certificateThumbprint;

  if (!thumbprint) {
    return {
      id: "signing-windows",
      target: "windows",
      status: "warn",
      message: `[native] no windows signing configured — ${LEGAL_NOTE}.`,
      fixIt: "set signing.windows.certificateThumbprint to sign release installers"
    };
  }
  return {
    id: "signing-windows",
    target: "windows",
    status: "pass",
    message: "[native] windows signing certificate thumbprint is configured."
  };
}

/**
 * Dispatches to the Apple, Android or Windows signing presence check by target.
 *
 * @param input - The check input, scoped to "ios", "macos", "android" or "windows".
 * @returns The check result.
 */
async function run(input: CheckInput): Promise<CheckResult> {
  if (input.target === "android") return checkAndroidSigning(input);
  if (input.target === "windows") return checkWindowsSigning(input);
  if (input.target === "ios" || input.target === "macos") return checkAppleSigning(input);
  throw new Error(`[native] signing check does not apply to target "${input.target}".`);
}

/**
 * Signing readiness (presence and counts, never values) — ios/macos/android/windows,
 * warn-only.
 */
export const signingCheck: Check = {
  id: "signing",
  /**
   * The per-target id every signing result carries (`signing-ios`, `signing-android`, …).
   *
   * @param scope - The scope the check ran against.
   * @returns The per-scope result id.
   * @example
   * ```ts
   * signingCheck.resultId?.("macos"); // "signing-macos"
   * ```
   */
  resultId: scope => `signing-${scope}`,
  /**
   * Whether this check applies — every target that carries a signing identifier or env ref.
   *
   * @param target - The candidate scope.
   * @returns Whether `signing` applies to `target`.
   * @example
   * ```ts
   * signingCheck.appliesTo("android", global); // true
   * ```
   */
  appliesTo: target =>
    target === "ios" || target === "macos" || target === "android" || target === "windows",
  run
};
