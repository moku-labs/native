/* eslint-disable sonarjs/no-hardcoded-secrets, sonarjs/no-hardcoded-passwords -- these are
   synthetic fixtures FOR the scrubber test suite (asserting they get masked), never real secrets. */
import { describe, expect, it } from "vitest";
import { scrub } from "../../scrub";

describe("scrub", () => {
  it("masks a long high-entropy token", () => {
    const secret = "Tr0ub4dor&3Zx9Qm7Lp2Vy8Wn5Rk1Bc6Ds4Fg";
    const result = scrub(`auth token: ${secret} accepted`);
    expect(result).not.toContain(secret);
    expect(result).toBe("auth token: [native:scrubbed] accepted");
  });

  it("preserves a long but low-entropy token", () => {
    const repeated = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(scrub(`padding: ${repeated} done`)).toBe(`padding: ${repeated} done`);
  });

  it("preserves short, ordinary output", () => {
    const line = "Compiling serde v1.0.190";
    expect(scrub(line)).toBe(line);
  });

  it("always masks known secret env-var assignments regardless of entropy", () => {
    const result = scrub("APPLE_PASSWORD=hunter2 APPLE_CERTIFICATE_PASSWORD: xyzzy");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("xyzzy");
    expect(result).toContain("APPLE_PASSWORD=[native:scrubbed]");
    expect(result).toContain("APPLE_CERTIFICATE_PASSWORD: [native:scrubbed]");
  });

  it("masks TAURI_SIGNING_* variables by prefix", () => {
    const result = scrub("TAURI_SIGNING_PRIVATE_KEY=abc123");
    expect(result).toBe("TAURI_SIGNING_PRIVATE_KEY=[native:scrubbed]");
  });
});
