/**
 * @file doctor plugin check — the installed iOS platform: simulator SDKs (`xcodebuild
 * -showsdks`) and simulator runtimes (`xcrun simctl list runtimes`). A17; ios on a macOS
 * host only. Warn-only, and only when NO simulator runtime is installed — a runtime newer
 * than the SDK is a normal, working setup.
 */
import process from "node:process";
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/** An `xcrun simctl list runtimes` line: `iOS 26.3 (26.3.1 - 23D8133) - com.apple…`. */
const RUNTIME_LINE = /^iOS\s+([\d.]+)/;

/** An `xcodebuild -showsdks` simulator line ends with `-sdk iphonesimulator26.2`. */
const SIMULATOR_SDK = /-sdk iphonesimulator([\d.]+)/g;

/** The one fix-it that installs a missing iOS platform (SDK + simulator runtime). */
const DOWNLOAD_FIX_IT = "xcodebuild -downloadPlatform iOS";

/**
 * Extracts the versions of the INSTALLED iOS simulator runtimes — `simctl` keeps listing
 * runtimes it can no longer use, marked `unavailable`, and those do not count.
 *
 * @param stdout - Raw `xcrun simctl list runtimes` output.
 * @returns The installed iOS runtime versions, in listed order.
 * @example
 * ```ts
 * parseInstalledRuntimes("iOS 26.3 (26.3.1 - 23D8133) - com.apple…"); // ["26.3"]
 * ```
 */
function parseInstalledRuntimes(stdout: string): readonly string[] {
  const versions: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes("unavailable")) continue;

    const version = RUNTIME_LINE.exec(trimmed)?.[1];
    if (version) versions.push(version);
  }
  return versions;
}

/**
 * Extracts the iOS simulator SDK versions from `xcodebuild -showsdks` output.
 *
 * @param stdout - Raw `xcodebuild -showsdks` output.
 * @returns The simulator SDK versions, in listed order.
 * @example
 * ```ts
 * parseSimulatorSdks("\tSimulator - iOS 26.2  \t-sdk iphonesimulator26.2"); // ["26.2"]
 * ```
 */
function parseSimulatorSdks(stdout: string): readonly string[] {
  return [...stdout.matchAll(SIMULATOR_SDK)]
    .map(match => match[1])
    .filter((version): version is string => version !== undefined);
}

/**
 * Confirms the iOS platform is actually installed: at least one usable simulator runtime,
 * reported alongside whatever simulator SDKs Xcode ships.
 *
 * @param input - The check input, scoped to the "ios" target.
 * @returns The check result — "pass" or "warn", never "fail".
 * @example
 * ```ts
 * await run({ target: "ios", probe, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const [sdks, runtimes] = await Promise.all([
    input.probe("xcodebuild", ["-showsdks"]),
    input.probe("xcrun", ["simctl", "list", "runtimes"])
  ]);

  if (runtimes.code !== 0) {
    return {
      id: "ios-platform",
      target: "ios",
      status: "warn",
      message: "[native] could not list iOS simulator runtimes (`xcrun simctl list runtimes`).",
      fixIt: "open Xcode once to finish installing the iOS platform, then re-run `native doctor`"
    };
  }

  const installed = parseInstalledRuntimes(runtimes.stdout);
  if (installed.length === 0) {
    return {
      id: "ios-platform",
      target: "ios",
      status: "warn",
      message: "[native] no iOS simulator runtime is installed — simulator builds cannot run.",
      fixIt: DOWNLOAD_FIX_IT
    };
  }

  const sdkVersions = sdks.code === 0 ? parseSimulatorSdks(sdks.stdout) : [];
  const sdkNote = sdkVersions.length > 0 ? ` (simulator SDK ${sdkVersions.join(", ")})` : "";
  return {
    id: "ios-platform",
    target: "ios",
    status: "pass",
    message: `[native] iOS simulator runtime ${installed.join(", ")} is installed${sdkNote}.`
  };
}

/** Installed iOS platform (simulator SDKs + runtimes) — ios on a macOS host only. */
export const iosPlatformCheck: Check = {
  id: "ios-platform",
  /**
   * Whether this check applies — ios only, and only on a macOS host.
   *
   * @param target - The candidate scope.
   * @returns Whether `ios-platform` applies to `target`.
   * @example
   * ```ts
   * iosPlatformCheck.appliesTo("ios", global); // true on a macOS host
   * ```
   */
  appliesTo: target => target === "ios" && process.platform === "darwin",
  run
};
