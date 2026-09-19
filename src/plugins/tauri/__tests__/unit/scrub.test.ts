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

  it("masks a 32-character base64 secret", () => {
    const secret = "aB3xQ9zP1mK7vR2tY8wL4nC6jF0sH5dG";
    const result = scrub(`APPLE token ${secret} accepted`);
    expect(result).not.toContain(secret);
    expect(result).toBe("APPLE token [native:scrubbed] accepted");
  });

  it("masks a 24-character base64 secret (shortest length still scanned)", () => {
    const secret = "aB3xQ9zP1mK7vR2tY8wL4nC6";
    const result = scrub(`issuer ${secret} ok`);
    expect(result).not.toContain(secret);
    expect(result).toBe("issuer [native:scrubbed] ok");
  });

  it("preserves a long but low-entropy token", () => {
    const repeated = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(scrub(`padding: ${repeated} done`)).toBe(`padding: ${repeated} done`);
  });

  it("preserves short, ordinary output", () => {
    const line = "Compiling serde v1.0.190";
    expect(scrub(line)).toBe(line);
  });

  it("preserves a cargo registry path (a location, never a secret)", () => {
    const line =
      "Compiling serde v1.0.190 (/Users/alex/.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.190)";
    expect(scrub(line)).toBe(line);
  });

  it("preserves a POSIX artifact path and a URL", () => {
    const line =
      "bundled /var/folders/t7/moku-native-a9Fk3/src-tauri/target/release/bundle/dmg/App_1.0.0.dmg from https://github.com/moku-labs/native/releases/download/v1.0.0";
    expect(scrub(line)).toBe(line);
  });

  it("preserves a Windows path and a Rust module path", () => {
    const line = String.raw`C:\Users\alex\AppData\Local\Temp\moku-native-a9Fk3Qz panicked at core::result::Result::unwrap`;
    expect(scrub(line)).toBe(line);
  });

  it("always masks known secret env-var assignments regardless of entropy", () => {
    const result = scrub("APPLE_PASSWORD=hunter2 APPLE_CERTIFICATE_PASSWORD: xyzzy");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("xyzzy");
    expect(result).toContain("APPLE_PASSWORD=[native:scrubbed]");
    expect(result).toContain("APPLE_CERTIFICATE_PASSWORD: [native:scrubbed]");
  });

  it("masks a known secret env-var value even when it looks like a path", () => {
    const result = scrub("APPLE_API_KEY_PATH=/Users/alex/keys/AuthKey_ABC123DEF4.p8");
    expect(result).toBe("APPLE_API_KEY_PATH=[native:scrubbed]");
  });

  it("masks TAURI_SIGNING_* variables by prefix", () => {
    const result = scrub("TAURI_SIGNING_PRIVATE_KEY=abc123");
    expect(result).toBe("TAURI_SIGNING_PRIVATE_KEY=[native:scrubbed]");
  });
});
