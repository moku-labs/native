import { describe, expect, it, vi } from "vitest";
import { iosPlatformCheck } from "../../../checks/ios-platform";
import type { ProbeFn } from "../../../types";
import { createCheckInput } from "./fixtures";

/** Real `xcodebuild -showsdks` excerpt — the simulator SDK line is tab-separated. */
const SHOWSDKS = [
  "iOS SDKs:",
  "\tiOS 26.2                      \t-sdk iphoneos26.2",
  "",
  "iOS Simulator SDKs:",
  "\tSimulator - iOS 26.2          \t-sdk iphonesimulator26.2",
  ""
].join("\n");

/** Real `xcrun simctl list runtimes` excerpt — a runtime NEWER than the SDK is fine. */
const RUNTIMES = [
  "== Runtimes ==",
  "iOS 26.3 (26.3.1 - 23D8133) - com.apple.CoreSimulator.SimRuntime.iOS-26-3",
  ""
].join("\n");

/** `xcrun simctl list runtimes` with only an unavailable (not installed) iOS runtime. */
const RUNTIMES_UNAVAILABLE = [
  "== Runtimes ==",
  "iOS 18.0 (18.0 - 22A3351) - com.apple.CoreSimulator.SimRuntime.iOS-18-0 (unavailable, runtime profile not found)",
  ""
].join("\n");

/** Temporarily overrides `process.platform` for the duration of `fn`. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

/**
 * Builds a probe fake answering the two platform probes.
 *
 * @param opts - The stdout/exit answers for each probe.
 * @param opts.sdks - `xcodebuild -showsdks` stdout.
 * @param opts.runtimes - `xcrun simctl list runtimes` stdout.
 * @param opts.failing - Commands whose probe reports a non-zero exit.
 * @returns The probe fake.
 */
function createProbe(
  opts: { sdks?: string; runtimes?: string; failing?: readonly string[] } = {}
): ProbeFn {
  return vi.fn(async (cmd: string) => {
    if (opts.failing?.includes(cmd)) return { code: 1, stdout: "" };
    if (cmd === "xcodebuild") return { code: 0, stdout: opts.sdks ?? SHOWSDKS };
    return { code: 0, stdout: opts.runtimes ?? RUNTIMES };
  });
}

describe("iosPlatformCheck.appliesTo", () => {
  it("applies to ios on a darwin host only", () => {
    withPlatform("darwin", () => {
      expect(iosPlatformCheck.appliesTo("ios", createCheckInput().global)).toBe(true);
      expect(iosPlatformCheck.appliesTo("host", createCheckInput().global)).toBe(false);
    });
    withPlatform("linux", () => {
      expect(iosPlatformCheck.appliesTo("ios", createCheckInput().global)).toBe(false);
    });
  });
});

describe("iosPlatformCheck.run", () => {
  it("passes when a simulator runtime is installed, even one newer than the SDK", async () => {
    const probe = createProbe();

    const result = await iosPlatformCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("pass");
    expect(result.id).toBe("ios-platform");
    expect(result.message).toContain("26.3");
    expect(probe).toHaveBeenCalledWith("xcodebuild", ["-showsdks"]);
    expect(probe).toHaveBeenCalledWith("xcrun", ["simctl", "list", "runtimes"]);
  });

  it("warns with the downloadPlatform fix-it when no iOS runtime is listed", async () => {
    const probe = createProbe({ runtimes: "== Runtimes ==\n" });

    const result = await iosPlatformCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("warn");
    expect(result.fixIt).toContain("xcodebuild -downloadPlatform iOS");
  });

  it("treats an unavailable runtime as not installed", async () => {
    const probe = createProbe({ runtimes: RUNTIMES_UNAVAILABLE });

    const result = await iosPlatformCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("warn");
  });

  it("warns (never fails) when the simctl probe itself fails", async () => {
    const probe = createProbe({ failing: ["xcrun"] });

    const result = await iosPlatformCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("warn");
    expect(result.message.startsWith("[native]")).toBe(true);
  });

  it("still passes when the SDK list is unreadable but a runtime is installed", async () => {
    const probe = createProbe({ failing: ["xcodebuild"] });

    const result = await iosPlatformCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("pass");
  });
});
