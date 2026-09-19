/* eslint-disable unicorn/no-null -- `code: number | null` mirrors the real Node child-process
   exit-code shape (spec/02's Node-mirroring reconciliation), not a lazy fallback. */
import { describe, expect, it } from "vitest";
import { classify, TauriError } from "../../errors";

describe("classify", () => {
  it("classifies signing failures", () => {
    const error = classify(1, "error: codesign failed: no identity found in keychain");
    expect(error).toBeInstanceOf(TauriError);
    expect(error.kind).toBe("signing-failed");
    expect(error.message).toMatch(/^\[native\]/);
  });

  it("classifies an unsigned-build refusal as signing-failed", () => {
    const error = classify(1, "error: No code signing certificates were found for this account");
    expect(error.kind).toBe("signing-failed");
  });

  it("classifies a notarization failure as signing-failed", () => {
    const error = classify(1, "failed to notarize the app bundle: invalid credentials");
    expect(error.kind).toBe("signing-failed");
  });

  it("classifies missing toolchain", () => {
    const error = classify(127, "xcode-select: error: tool 'xcodebuild' requires Xcode");
    expect(error.kind).toBe("toolchain-missing");
  });

  it("classifies a missing simulator platform as platform-missing", () => {
    const error = classify(
      1,
      "iOS 18.2 is not installed. Please download and install the platform"
    );
    expect(error.kind).toBe("platform-missing");
    expect(error.message).toContain("xcodebuild -downloadPlatform iOS");
  });

  it("classifies an empty destination list as platform-missing, not device-unavailable", () => {
    const error = classify(
      70,
      "xcodebuild: error: Found no destinations for the scheme 'demo_iOS'. No devices found."
    );
    expect(error.kind).toBe("platform-missing");
  });

  it("classifies unavailable devices", () => {
    const error = classify(1, "No devices found. Please connect a device or start a simulator.");
    expect(error.kind).toBe("device-unavailable");
  });

  it("classifies invalid config", () => {
    const error = classify(1, "Error: failed to parse tauri.conf.json: unexpected token");
    expect(error.kind).toBe("config-invalid");
  });

  it("classifies an unreadable config", () => {
    const error = classify(1, "Error: failed to read tauri.conf.json: no such file");
    expect(error.kind).toBe("config-invalid");
  });

  it("does not classify a bare tauri.conf mention as config-invalid", () => {
    const error = classify(1, "info: rewriting tauri.conf.json before the build");
    expect(error.kind).toBe("unknown");
  });

  it("classifies compile failures", () => {
    const error = classify(101, "error[E0432]: unresolved import `foo`\n --> src/main.rs:1:5");
    expect(error.kind).toBe("compile-failed");
  });

  it("classifies a null exit code with no matching pattern as cancelled", () => {
    const error = classify(null, "");
    expect(error.kind).toBe("cancelled");
  });

  it("falls back to unknown for an unrecognized non-zero exit", () => {
    const error = classify(1, "some unrelated failure message");
    expect(error.kind).toBe("unknown");
  });

  it("carries the exit code and a scrubbed stderr tail", () => {
    const error = classify(101, "line one\nline two\nerror[E0432]: unresolved import `foo`");
    expect(error.exitCode).toBe(101);
    expect(error.stderrTail).toContain("error[E0432]");
  });
});
