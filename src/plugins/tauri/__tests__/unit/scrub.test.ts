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

  it("preserves an xcodebuild simulator destination line (canonical UUIDs are ids, not secrets)", () => {
    const line =
      "{ platform:iOS Simulator, arch:arm64, id:41E558D0-66F5-4CA4-90E5-075F9BC510DC, OS:26.3.1, name:iPad Air 13-inch }";
    expect(scrub(line)).toBe(line);
  });

  it("preserves a high-entropy simulator UUID (above the entropy bar, still not a secret)", () => {
    const line =
      "{ platform:iOS Simulator, arch:arm64, id:C0D577B6-80F3-4C1F-99F5-3882D36EB42D, OS:26.3.1, name:iPhone 17 Pro }";
    expect(scrub(line)).toBe(line);
  });

  it("preserves a bare canonical UUID", () => {
    const line = "booted C0D577B6-80F3-4C1F-99F5-3882D36EB42D ok";
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

  it("masks a quoted secret value together with the spaces inside it", () => {
    const result = scrub('APPLE_PASSWORD="correct horse battery" staple');
    expect(result).not.toContain("horse");
    expect(result).toBe("APPLE_PASSWORD=[native:scrubbed] staple");
  });

  it("masks a single-quoted secret value", () => {
    const result = scrub("ANDROID_KEYSTORE_PASSWORD: 'two words' ok");
    expect(result).not.toContain("two words");
    expect(result).toBe("ANDROID_KEYSTORE_PASSWORD: [native:scrubbed] ok");
  });

  it("masks URL userinfo even though a URL is location-shaped", () => {
    const result = scrub(
      "fatal: cannot read https://alex:ghp_A1b2C3d4E5@github.com/moku/native.git"
    );
    expect(result).not.toContain("ghp_A1b2C3d4E5");
    expect(result).toBe("fatal: cannot read https://[native:scrubbed]@github.com/moku/native.git");
  });

  it("masks a high-entropy path SEGMENT and keeps the rest of the path readable", () => {
    const secret = "aB3xQ9zP1mK7vR2tY8wL4nC6jF0sH5dG";
    const result = scrub(`uploading /var/tmp/${secret}/App.dmg`);
    expect(result).not.toContain(secret);
    expect(result).toBe("uploading /var/tmp/[native:scrubbed]/App.dmg");
  });

  it("masks a 40-character hex token (hex entropy alone never clears the bar)", () => {
    const token = "9f2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    expect(scrub(`token ${token} sent`)).toBe("token [native:scrubbed] sent");
  });

  it("masks a 64-character hex token", () => {
    const token = "9f2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809";
    expect(scrub(`digest ${token}`)).toBe("digest [native:scrubbed]");
  });

  it("preserves a git sha announced by its context", () => {
    const sha = "9f2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    expect(scrub(`commit ${sha}`)).toBe(`commit ${sha}`);
    expect(scrub(`rev ${sha}`)).toBe(`rev ${sha}`);
  });

  it("preserves a git sha announced by the cargo git+ source it belongs to", () => {
    const line =
      "git+https://github.com/tauri-apps/plugins-workspace#9f2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    expect(scrub(line)).toBe(line);
  });

  it("masks a long hex run announced by nothing but a bare #", () => {
    const secret = "9f2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    expect(scrub(`#${secret}`)).toBe("#[native:scrubbed]");
  });

  it("preserves a Cargo.lock checksum (a published digest, not a secret)", () => {
    const line = 'checksum = "9f2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809"';
    expect(scrub(line)).toBe(line);
  });

  it("preserves a cargo registry source reference", () => {
    const line =
      "Compiling serde v1.0.190 (registry+https://github.com/rust-lang/crates.io-index#serde@1.0.190)";
    expect(scrub(line)).toBe(line);
  });

  it("preserves the crates.io registry path segment", () => {
    const line =
      "Compiling serde (/Users/alex/.cargo/registry/src/index.crates.io-6f17d22bba15001f)";
    expect(scrub(line)).toBe(line);
  });
});

describe("scrub — build paths whose segments clear the entropy bar as a whole", () => {
  it.each([
    [
      "a cargo rlib carrying its metadata hash",
      "/repo/.moku/tauri/src-tauri/target/release/deps/libtauri_app-9f8e7d6c5b4a3210.rlib"
    ],
    [
      "a dependency rlib",
      "/repo/.moku/tauri/src-tauri/target/release/deps/libserde_json-4b1c9a7e2f3d5608.rlib"
    ],
    [
      "an Xcode DerivedData workspace directory",
      "/Users/alex/Library/Developer/Xcode/DerivedData/smoke-two-hejevvdkuvivblgxsjzgmphfevnl/Build/Products/Release-iphoneos"
    ],
    [
      "a debug-symbol bundle",
      "/repo/.moku/tauri/src-tauri/target/release/moku-native-app-abcdefghijklmnop.dSYM"
    ],
    ["a content-hashed web asset", "/repo/dist/assets/main-3f2a9c1b.css"]
  ])("preserves %s", (_label, line) => {
    expect(scrub(line)).toBe(line);
  });

  it("still masks a secret that occupies a whole path part", () => {
    const secret = "aB3xQ9zP1mK7vR2tY8wL4nC6jF0sH5dG";
    const directory = "/repo/.moku/tauri/src-tauri/target/release/bundle/dmg";

    expect(scrub(`${directory}/App-${secret}.dmg`)).toBe(`${directory}/App-[native:scrubbed].dmg`);
  });
});
