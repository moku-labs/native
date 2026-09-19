/* eslint-disable unicorn/no-null -- `code: number | null` mirrors the real Node child-process
   exit-code shape (spec/02's Node-mirroring reconciliation), not a lazy fallback. */
import { describe, expect, it } from "vitest";
import { classify, TauriError } from "../../errors";

/** The real tail of an unsigned `tauri ios build --simulator` run on a clean host. */
const UNSIGNED_SIMULATOR_TAIL = [
  "        Warn No code signing certificates found. You must add one and set the certificate development team ID on the `bundle > iOS > developmentTeam` config value or the `APPLE_DEVELOPMENT_TEAM` environment variable.",
  "** BUILD FAILED **",
  "The following build commands failed:",
  String.raw`	PhaseScriptExecution Build\ Rust\ Code /Users/x/Library/Developer/Xcode/DerivedData/app/Build/Intermediates.noindex/app.build/release-iphonesimulator/app_iOS.build/Script-80C98B.sh (in target 'app_iOS' from project 'app')`,
  "(2 failures)",
  'failed to build iOS app: failed to build with xcodebuild: command ["xcodebuild"] exited with code 65'
].join("\n");

describe("classify", () => {
  it("classifies signing failures", () => {
    const error = classify(1, "error: codesign failed: no identity found in keychain");
    expect(error).toBeInstanceOf(TauriError);
    expect(error.kind).toBe("signing-failed");
    expect(error.message).toMatch(/^\[native\]/);
  });

  it("classifies a missing signing certificate as signing-failed", () => {
    const error = classify(1, 'error: No signing certificate "iOS Development" found');
    expect(error.kind).toBe("signing-failed");
  });

  it("classifies a missing provisioning profile as signing-failed", () => {
    const error = classify(
      65,
      "error: app_iOS requires a provisioning profile. Select a provisioning profile in the Signing & Capabilities editor."
    );
    expect(error.kind).toBe("signing-failed");
  });

  it("never classifies the harmless `Warn No code signing certificates` line as signing-failed", () => {
    const error = classify(
      1,
      "        Warn No code signing certificates found. You must add one and set the certificate development team ID on the `bundle > iOS > developmentTeam` config value."
    );
    expect(error.kind).not.toBe("signing-failed");
  });

  it("classifies a failed Build Rust Code phase as xcode-script-failed, not signing-failed", () => {
    const error = classify(65, UNSIGNED_SIMULATOR_TAIL);
    expect(error.kind).toBe("xcode-script-failed");
    expect(error.message).toContain("native clean --target ios");
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

describe("classify — stderrTail", () => {
  const destinations = Array.from(
    { length: 12 },
    (_, index) => `\t{ platform:iOS Simulator, arch:arm64, name:iPad Air 13-inch (M${index}) }`
  );
  const moduleError = "error: Cannot find module '/repo/node_modules/@tauri-apps/cli/tauri.js'";
  const phaseError = "Command PhaseScriptExecution failed with a nonzero exit code";
  const xcodebuildLog = [
    "Building app for iOS Simulator",
    moduleError,
    "export npm_lifecycle_script=bun run build || echo failed",
    "    GCC_TREAT_WARNINGS_AS_ERRORS = NO (not found in build settings)",
    moduleError,
    phaseError,
    ...destinations
  ].join("\n");

  it("lifts signal lines out of the whole log, ahead of the trailing lines", () => {
    const lines = classify(65, xcodebuildLog).stderrTail.split("\n");

    expect(lines.slice(0, 3)).toEqual([moduleError, phaseError, "…"]);
    expect(lines.slice(3)).toEqual(destinations.slice(-10));
  });

  it("de-duplicates repeated signal lines", () => {
    const tail = classify(65, xcodebuildLog).stderrTail;
    expect(tail.split(moduleError)).toHaveLength(2);
  });

  it("excludes `export ` lines and Xcode's *_ERROR build settings from the signal lines", () => {
    const tail = classify(65, xcodebuildLog).stderrTail;
    expect(tail).not.toContain("npm_lifecycle_script");
    expect(tail).not.toContain("WARNINGS_AS_ERRORS");
  });

  it("keeps at most 15 signal lines", () => {
    const failures = Array.from({ length: 20 }, (_, index) => `error: failure ${index}`);
    const lines = classify(1, failures.join("\n")).stderrTail.split("\n");

    expect(lines.slice(0, 15)).toEqual(failures.slice(0, 15));
    expect(lines[15]).toBe("…");
    expect(lines.slice(16)).toEqual(failures.slice(-10));
  });

  it("omits the separator when nothing in the output looks like a cause", () => {
    expect(classify(1, "alpha\nbeta").stderrTail).toBe("alpha\nbeta");
  });
});
