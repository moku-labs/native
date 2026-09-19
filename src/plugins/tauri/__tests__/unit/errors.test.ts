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

  it("classifies missing toolchain", () => {
    const error = classify(127, "xcode-select: error: tool 'xcodebuild' requires Xcode");
    expect(error.kind).toBe("toolchain-missing");
  });

  it("classifies unavailable devices", () => {
    const error = classify(1, "No devices found. Please connect a device or start a simulator.");
    expect(error.kind).toBe("device-unavailable");
  });

  it("classifies invalid config", () => {
    const error = classify(1, "Error: failed to parse tauri.conf.json: unexpected token");
    expect(error.kind).toBe("config-invalid");
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
