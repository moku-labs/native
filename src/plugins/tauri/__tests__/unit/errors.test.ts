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

  it("ignores an incidental signing mention on an ordinary build-step line", () => {
    // A real xcodebuild log narrates every step; `CodeSign <path>` and the keychain lines it
    // exports are progress output, not the cause, and must never outrank the real error.
    const log = [
      "CodeSign /Users/x/Library/Developer/Xcode/DerivedData/app.app (in target 'app_iOS')",
      "    cd /repo/src-tauri/gen/apple",
      "export CODESIGN_ALLOCATE=/usr/bin/codesign_allocate",
      "Signing Identity: - (keychain: login.keychain-db)",
      "error[E0432]: unresolved import `foo`"
    ].join("\n");

    expect(classify(101, log).kind).toBe("compile-failed");
  });

  it("classifies over cause lines only — a log with none of them is unknown", () => {
    const log = ["CodeSign /Users/x/app.app", "Signing Identity: -"].join("\n");

    expect(classify(1, log).kind).toBe("unknown");
  });

  it("carries the exit code and a scrubbed stderr tail", () => {
    const error = classify(101, "line one\nline two\nerror[E0432]: unresolved import `foo`");
    expect(error.exitCode).toBe(101);
    expect(error.stderrTail).toContain("error[E0432]");
  });
});

describe("classify — every taxonomy alternative is reachable", () => {
  // One real-shaped line per alternative in the taxonomy table. The classifier only ever
  // looks at SIGNAL lines, so an alternative whose only realistic line is not a signal line
  // is unreachable in production however well its own pattern is written.
  it.each([
    ["xcode-script-failed", String.raw`PhaseScriptExecution Build\ Rust\ Code /repo/Script-80C.sh`],
    ["signing-failed", "codesign failed with exit code 1"],
    ["signing-failed", 'error: No signing certificate "iOS Development" found'],
    ["signing-failed", "error: app_iOS requires a provisioning profile"],
    ["signing-failed", "failed to notarize the app bundle"],
    ["signing-failed", "error: unable to unlock the login keychain"],
    ["signing-failed", "signtool.exe failed: SignTool Error: no certificates were found"],
    ["signing-failed", "jarsigner error: unable to sign jar"],
    ["signing-failed", "error: keystore file does not exist"],
    ["toolchain-missing", "sh: tauri: command not found"],
    ["toolchain-missing", "xcode-select: error: tool 'xcodebuild' requires Xcode"],
    ["toolchain-missing", "Error: ANDROID_HOME is not set"],
    ["toolchain-missing", "ndk not found"],
    ["toolchain-missing", "ndk is not installed"],
    ["toolchain-missing", "rustup: command not found"],
    ["toolchain-missing", "sh: cargo: not found"],
    ["platform-missing", "iOS 18.2 is not installed. Please download and install the platform"],
    ["platform-missing", "xcodebuild: error: Found no destinations for the scheme 'app_iOS'"],
    ["device-unavailable", "No devices found."],
    ["device-unavailable", "error: device not found"],
    ["device-unavailable", "Unable to lookup in current state: simulator not booted"],
    ["device-unavailable", "simulator not found"],
    ["device-unavailable", "no emulators found"],
    ["device-unavailable", "adb: no devices/emulators found"],
    ["config-invalid", "failed to parse /repo/src-tauri/tauri.conf.json"],
    ["config-invalid", "failed to read /repo/src-tauri/tauri.conf.json"],
    ["config-invalid", "invalid config: unknown field `bundle.foo`"],
    ["config-invalid", "schema validation failed"],
    ["compile-failed", "error[E0432]: unresolved import `foo`"],
    ["compile-failed", "error: could not compile `app` (lib) due to 1 previous error"],
    ["compile-failed", "compilation failed"]
  ])("classifies %s from %j", (kind, line) => {
    expect(classify(1, line).kind).toBe(kind);
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

  it("keeps the LAST 15 signal lines — the cause is at the end of a build log", () => {
    const failures = Array.from({ length: 20 }, (_, index) => `error: failure ${index}`);
    const lines = classify(1, failures.join("\n")).stderrTail.split("\n");

    expect(lines.slice(0, 15)).toEqual(failures.slice(-15));
    expect(lines[15]).toBe("…");
    expect(lines.slice(16)).toEqual(failures.slice(-10));
  });

  it("lifts the failing build-phase line xcodebuild lists under its failure summary", () => {
    const tail = classify(65, UNSIGNED_SIMULATOR_TAIL).stderrTail;

    expect(tail.split("…")[0]).toContain(String.raw`PhaseScriptExecution Build\ Rust\ Code`);
  });

  it("omits the separator when nothing in the output looks like a cause", () => {
    expect(classify(1, "alpha\nbeta").stderrTail).toBe("alpha\nbeta");
  });
});
