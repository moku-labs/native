import { describe, expect, it } from "vitest";
import { signingCheck } from "../../../checks/signing";
import { baseGlobalConfig, createCheckInput, createEnv } from "./fixtures";

describe("signingCheck.appliesTo", () => {
  it("applies to ios, macos, and android", () => {
    expect(signingCheck.appliesTo("ios", createCheckInput().global)).toBe(true);
    expect(signingCheck.appliesTo("macos", createCheckInput().global)).toBe(true);
    expect(signingCheck.appliesTo("android", createCheckInput().global)).toBe(true);
  });

  it("does not apply to windows, linux, or host", () => {
    expect(signingCheck.appliesTo("windows", createCheckInput().global)).toBe(false);
    expect(signingCheck.appliesTo("linux", createCheckInput().global)).toBe(false);
    expect(signingCheck.appliesTo("host", createCheckInput().global)).toBe(false);
  });
});

describe("signingCheck.run — ios/macos (Apple)", () => {
  it("warns (never fails) when no Apple signing env vars are set", async () => {
    const result = await signingCheck.run(createCheckInput({ target: "macos", env: createEnv() }));

    expect(result.status).toBe("warn");
    expect(result.target).toBe("macos");
  });

  it("warns and names the still-missing vars when only some are set", async () => {
    const env = createEnv({ APPLE_ID: "set" });
    const result = await signingCheck.run(createCheckInput({ target: "ios", env }));

    expect(result.status).toBe("warn");
    expect(result.message).toContain("APPLE_PASSWORD");
    expect(result.message).toContain("APPLE_TEAM_ID");
  });

  it("passes when every Apple signing env var is set", async () => {
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- fixture value, not a secret; presence-only assertion below.
    const env = createEnv({ APPLE_ID: "set", APPLE_PASSWORD: "set", APPLE_TEAM_ID: "set" });
    const result = await signingCheck.run(createCheckInput({ target: "ios", env }));

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
