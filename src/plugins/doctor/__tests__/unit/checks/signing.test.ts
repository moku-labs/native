import { describe, expect, it, vi } from "vitest";
import { signingCheck } from "../../../checks/signing";
import type { ProbeFn } from "../../../types";
import { baseGlobalConfig, createCheckInput, createEnv } from "./fixtures";

/** A complete notarization credential set (app-specific password flavour). */
const NOTARIZATION_ENV = {
  APPLE_ID: "set",
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- fixture value, not a secret; presence-only assertions below.
  APPLE_PASSWORD: "set",
  APPLE_TEAM_ID: "set"
};

/** A complete App Store Connect API-key credential set. */
const API_KEY_ENV = {
  APPLE_API_KEY: "set",
  APPLE_API_ISSUER: "set",
  APPLE_API_KEY_PATH: "set"
};

/** Real `security find-identity -v -p codesigning` output shape — two identities. */
const TWO_IDENTITIES = [
  '  1) AAAA1111 "Apple Development: Alex (TEAM123)"',
  '  2) BBBB2222 "Developer ID Application: Alex (TEAM123)"',
  "     2 valid identities found"
].join("\n");

/** Real keychain output with no codesigning identity at all. */
const NO_IDENTITIES = "     0 valid identities found";

/**
 * Builds a probe fake for the keychain probe.
 *
 * @param stdout - The `security find-identity` stdout to answer with.
 * @returns The probe fake.
 */
function createProbe(stdout: string): ProbeFn {
  return vi.fn(async () => ({ code: 0, stdout }));
}

/**
 * Builds a global config whose `signing.apple` carries the given fields.
 *
 * @param apple - The `signing.apple` fields under test.
 * @param apple.teamId - Apple Developer team id (ios wants it).
 * @param apple.signingIdentity - Codesign identity; `"-"` means ad-hoc.
 * @returns A frozen-shaped global config fixture.
 */
function withApple(apple: { teamId?: string; signingIdentity?: string }) {
  return { ...baseGlobalConfig, signing: { apple } };
}

describe("signingCheck.appliesTo", () => {
  it("applies to ios, macos, android, and windows", () => {
    expect(signingCheck.appliesTo("ios", createCheckInput().global)).toBe(true);
    expect(signingCheck.appliesTo("macos", createCheckInput().global)).toBe(true);
    expect(signingCheck.appliesTo("android", createCheckInput().global)).toBe(true);
    expect(signingCheck.appliesTo("windows", createCheckInput().global)).toBe(true);
  });

  it("does not apply to linux or host", () => {
    expect(signingCheck.appliesTo("linux", createCheckInput().global)).toBe(false);
    expect(signingCheck.appliesTo("host", createCheckInput().global)).toBe(false);
  });
});

describe("signingCheck.run — windows", () => {
  it("warns when no certificate thumbprint is configured", async () => {
    const result = await signingCheck.run(createCheckInput({ target: "windows" }));

    expect(result.status).toBe("warn");
    expect(result.id).toBe("signing-windows");
    expect(result.message).toContain("no windows signing configured");
    expect(result.fixIt).toContain("signing.windows.certificateThumbprint");
  });

  it("passes once a thumbprint is configured, without ever printing it", async () => {
    const result = await signingCheck.run(
      createCheckInput({
        target: "windows",
        global: { ...baseGlobalConfig, signing: { windows: { certificateThumbprint: "A1B2C3" } } }
      })
    );

    expect(result.status).toBe("pass");
    expect(result.message).not.toContain("A1B2C3");
  });
});

describe("signingCheck.run — Apple credential sets (either-or)", () => {
  it("warns (never fails) when neither credential set is complete", async () => {
    const result = await signingCheck.run(createCheckInput({ target: "macos", env: createEnv() }));

    expect(result.status).toBe("warn");
    expect(result.target).toBe("macos");
    expect(result.message).toContain("unsigned and simulator builds are legal");
  });

  it("names both credential sets in the fix-it when only some vars are set", async () => {
    const env = createEnv({ APPLE_ID: "set" });

    const result = await signingCheck.run(createCheckInput({ target: "macos", env }));

    expect(result.status).toBe("warn");
    expect(result.fixIt).toContain("APPLE_PASSWORD");
    expect(result.fixIt).toContain("APPLE_TEAM_ID");
    expect(result.fixIt).toContain("APPLE_API_KEY");
  });

  it("passes on the notarization set alone", async () => {
    const env = createEnv(NOTARIZATION_ENV);

    const result = await signingCheck.run(createCheckInput({ target: "macos", env }));

    expect(result.status).toBe("pass");
  });

  it("passes on the App Store Connect API-key set alone", async () => {
    const env = createEnv(API_KEY_ENV);

    const result = await signingCheck.run(createCheckInput({ target: "macos", env }));

    expect(result.status).toBe("pass");
  });

  it("never includes env var VALUES in the message or fixIt — presence only", async () => {
    const secretValue = "super-secret-apple-id@example.com";
    const env = createEnv({ APPLE_ID: secretValue });

    const result = await signingCheck.run(createCheckInput({ target: "ios", env }));

    expect(result.message).not.toContain(secretValue);
    expect(result.fixIt ?? "").not.toContain(secretValue);
  });
});

describe("signingCheck.run — ios wants signing.apple.teamId", () => {
  it("warns when credentials are complete but teamId is not configured", async () => {
    const env = createEnv(NOTARIZATION_ENV);

    const result = await signingCheck.run(createCheckInput({ target: "ios", env }));

    expect(result.status).toBe("warn");
    expect(result.message).toContain("signing.apple.teamId");
    expect(result.message).toContain("unsigned and simulator builds are legal");
  });

  it("passes once teamId is configured", async () => {
    const env = createEnv(NOTARIZATION_ENV);
    const global = withApple({ teamId: "TEAM123" });

    const result = await signingCheck.run(createCheckInput({ target: "ios", env, global }));

    expect(result.status).toBe("pass");
  });

  it("does not ask macos for teamId", async () => {
    const env = createEnv(NOTARIZATION_ENV);

    const result = await signingCheck.run(createCheckInput({ target: "macos", env }));

    expect(result.status).toBe("pass");
  });
});

describe("signingCheck.run — keychain identity probe", () => {
  it("counts identities only and never echoes them", async () => {
    const probe = createProbe(TWO_IDENTITIES);
    const env = createEnv(NOTARIZATION_ENV);
    const global = withApple({ signingIdentity: "Developer ID Application" });

    const result = await signingCheck.run(
      createCheckInput({ target: "macos", env, global, probe })
    );

    expect(probe).toHaveBeenCalledWith("security", ["find-identity", "-v", "-p", "codesigning"]);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("2");
    expect(result.message).not.toContain("Apple Development");
    expect(result.message).not.toContain("AAAA1111");
  });

  it("warns (never fails) when the keychain holds no codesigning identity", async () => {
    const probe = createProbe(NO_IDENTITIES);
    const env = createEnv(NOTARIZATION_ENV);
    const global = withApple({ signingIdentity: "Developer ID Application" });

    const result = await signingCheck.run(
      createCheckInput({ target: "macos", env, global, probe })
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("unsigned and simulator builds are legal");
  });

  it("skips the probe when signingIdentity is unset", async () => {
    const probe = createProbe(TWO_IDENTITIES);
    const env = createEnv(NOTARIZATION_ENV);

    const result = await signingCheck.run(createCheckInput({ target: "macos", env, probe }));

    expect(probe).not.toHaveBeenCalled();
    expect(result.status).toBe("pass");
  });

  it('skips the probe for the ad-hoc identity "-"', async () => {
    const probe = createProbe(TWO_IDENTITIES);
    const env = createEnv(NOTARIZATION_ENV);
    const global = withApple({ signingIdentity: "-" });

    const result = await signingCheck.run(
      createCheckInput({ target: "macos", env, global, probe })
    );

    expect(probe).not.toHaveBeenCalled();
    expect(result.status).toBe("pass");
  });

  it("skips the probe when APPLE_CERTIFICATE is set (CI imports its own keychain)", async () => {
    const probe = createProbe(NO_IDENTITIES);
    const env = createEnv({ ...NOTARIZATION_ENV, APPLE_CERTIFICATE: "base64" });
    const global = withApple({ signingIdentity: "Developer ID Application" });

    const result = await signingCheck.run(
      createCheckInput({ target: "macos", env, global, probe })
    );

    expect(probe).not.toHaveBeenCalled();
    expect(result.status).toBe("pass");
  });
});

describe("signingCheck.run — android", () => {
  it("warns when signing.android.keystorePasswordEnv is not configured", async () => {
    const result = await signingCheck.run(createCheckInput({ target: "android" }));

    expect(result.status).toBe("warn");
    expect(result.message.toLowerCase()).toContain("no android signing configured");
  });

  it("warns and names the configured env var when it is not set", async () => {
    const global = {
      ...baseGlobalConfig,
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- config-safe env var NAME, not a secret value (spec's own field name).
      signing: { android: { keystorePasswordEnv: "KEYSTORE_PW" } }
    };
    const result = await signingCheck.run(
      createCheckInput({ target: "android", global, env: createEnv() })
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("KEYSTORE_PW");
  });

  it("passes when the configured env var is set — never leaks its value", async () => {
    const global = {
      ...baseGlobalConfig,
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- config-safe env var NAME, not a secret value (spec's own field name).
      signing: { android: { keystorePasswordEnv: "KEYSTORE_PW" } }
    };
    const env = createEnv({ KEYSTORE_PW: "hunter2" });
    const result = await signingCheck.run(createCheckInput({ target: "android", global, env }));

    expect(result.status).toBe("pass");
    expect(result.message).not.toContain("hunter2");
  });
});
