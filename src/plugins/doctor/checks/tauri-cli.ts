/**
 * @file doctor plugin check — tauri CLI invokability via tauri.version() (D-013 subprocess
 * seam boundary: this is the ONE probe routed through tauri, not doctor's own probeImpl).
 */
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * Confirms the tauri CLI is invokable via the tauri plugin's own `version()` probe.
 *
 * @param input - The check input (host-scoped).
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "host", tauri, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const version = await input.tauri.version();
  if (!version) {
    return {
      id: "tauri-cli",
      target: "host",
      status: "fail",
      message: "[native] the tauri CLI is not invokable (`tauri info` failed).",
      fixIt: "ensure @tauri-apps/cli is installed and a real node binary is on PATH (tauri#9939)"
    };
  }
  return {
    id: "tauri-cli",
    target: "host",
    status: "pass",
    message: `[native] tauri CLI ${version.cliVersion} detected.`
  };
}

/** tauri CLI invokability — host-scoped, the one probe routed through the tauri plugin. */
export const tauriCliCheck: Check = {
  id: "tauri-cli",
  /**
   * Whether this check applies — host-scoped only (one CLI invocation, not per target).
   *
   * @param target - The candidate scope.
   * @returns Whether `tauri-cli` applies to `target`.
   * @example
   * ```ts
   * tauriCliCheck.appliesTo("host", global); // true
   * ```
   */
  appliesTo: target => target === "host",
  run
};
