/**
 * @file doctor plugin check — a real `node` binary on PATH (D-013: `@tauri-apps/cli`'s shebang
 * needs Node.js, distinct from bun).
 */
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * Confirms a real `node` binary is invokable — distinct from bun, since the
 * `@tauri-apps/cli` shebang requires Node.js (tauri#9939, D-013).
 *
 * @param input - The check input (host-scoped).
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "host", probe, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const result = await input.probe("node", ["--version"]);

  if (result.code !== 0) {
    return {
      id: "node-binary",
      target: "host",
      status: "fail",
      message:
        '[native] a real "node" binary was not found on PATH — the @tauri-apps/cli shebang requires Node.js, not bun (tauri#9939).',
      fixIt: "install Node.js and ensure it resolves on PATH ahead of any bun shim"
    };
  }

  return {
    id: "node-binary",
    target: "host",
    status: "pass",
    message: `[native] node ${result.stdout.trim()} detected.`
  };
}

/** Real `node` binary presence — a hard prerequisite for every tauri verb (D-013). */
export const nodeCheck: Check = {
  id: "node-binary",
  /**
   * Whether this check applies — host-scoped only.
   *
   * @param target - The candidate scope.
   * @returns Whether `node-binary` applies to `target`.
   * @example
   * ```ts
   * nodeCheck.appliesTo("host", global); // true
   * ```
   */
  appliesTo: target => target === "host",
  run
};
