/**
 * @file doctor plugin check — the iOS build tools `tauri ios` shells out to: `xcodegen`,
 * `pod`, and both rust target triples (device + simulator). ios on a macOS host only.
 */
import process from "node:process";
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/** Host binaries `tauri ios init/build` invokes, with the command that installs each. */
const IOS_BINARIES: ReadonlyArray<{ cmd: string; fixIt: string }> = [
  { cmd: "xcodegen", fixIt: "brew install xcodegen" },
  { cmd: "pod", fixIt: "brew install cocoapods" }
];

/** Rust target triples an iOS build needs — device and simulator are separate targets. */
const IOS_RUST_TARGETS: readonly string[] = ["aarch64-apple-ios", "aarch64-apple-ios-sim"];

/**
 * Probes each required binary for presence (a `--version` call that exits non-zero, or
 * cannot spawn at all, means "not on PATH").
 *
 * @param input - The check input (uses the injected probe seam).
 * @returns The binaries that are missing, each with its install command.
 * @example
 * ```ts
 * await findMissingBinaries(input); // [{ cmd: "xcodegen", fixIt: "brew install xcodegen" }]
 * ```
 */
async function findMissingBinaries(input: CheckInput): Promise<typeof IOS_BINARIES> {
  const probed = await Promise.all(
    IOS_BINARIES.map(async binary => ({
      binary,
      result: await input.probe(binary.cmd, ["--version"])
    }))
  );
  return probed.filter(entry => entry.result.code !== 0).map(entry => entry.binary);
}

/**
 * Reads `rustup target list --installed` (one triple per line) and reports which of the
 * two iOS triples are absent. A failed rustup probe means neither can be confirmed.
 *
 * @param input - The check input (uses the injected probe seam).
 * @returns The missing rust target triples.
 * @example
 * ```ts
 * await findMissingRustTargets(input); // ["aarch64-apple-ios-sim"]
 * ```
 */
async function findMissingRustTargets(input: CheckInput): Promise<readonly string[]> {
  const result = await input.probe("rustup", ["target", "list", "--installed"]);
  if (result.code !== 0) return IOS_RUST_TARGETS;

  const installed = new Set(result.stdout.split("\n").map(line => line.trim()));
  return IOS_RUST_TARGETS.filter(triple => !installed.has(triple));
}

/**
 * Confirms every iOS build tool is available, reporting all missing pieces in one result
 * with the exact commands that install them.
 *
 * @param input - The check input, scoped to the "ios" target.
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "ios", probe, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const [missingBinaries, missingTargets] = await Promise.all([
    findMissingBinaries(input),
    findMissingRustTargets(input)
  ]);

  if (missingBinaries.length === 0 && missingTargets.length === 0) {
    return {
      id: "ios-tools",
      target: "ios",
      status: "pass",
      message: `[native] iOS build tools are present: ${IOS_BINARIES.map(binary => binary.cmd).join(", ")}, rust targets ${IOS_RUST_TARGETS.join(", ")}.`
    };
  }

  const missing = [...missingBinaries.map(binary => binary.cmd), ...missingTargets];
  const fixIts = missingBinaries.map(binary => binary.fixIt);
  if (missingTargets.length > 0) {
    fixIts.push(`rustup target add ${missingTargets.join(" ")}`);
  }

  return {
    id: "ios-tools",
    target: "ios",
    status: "fail",
    message: `[native] missing iOS build tools: ${missing.join(", ")}.`,
    fixIt: fixIts.join("; ")
  };
}

/** iOS build tools (`xcodegen`, `pod`, both rust triples) — ios on a macOS host only. */
export const iosToolsCheck: Check = {
  id: "ios-tools",
  /**
   * Whether this check applies — ios only, and only on a macOS host.
   *
   * @param target - The candidate scope.
   * @returns Whether `ios-tools` applies to `target`.
   * @example
   * ```ts
   * iosToolsCheck.appliesTo("ios", global); // true on a macOS host
   * ```
   */
  appliesTo: target => target === "ios" && process.platform === "darwin",
  run
};
