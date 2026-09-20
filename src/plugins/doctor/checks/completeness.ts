/**
 * @file doctor plugin check — mobile gen/ required-file completeness gate (ios/android).
 */
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * Runs the mobile gen/ completeness gate for one target via `project.getCompleteness()` +
 * `project.getRequiredFiles()`. A missing gen/ tree is "will init on first build" (pass, not
 * fail) — only a PARTIAL init (tauri#13902) is a fail, and its fix-it is always the same
 * one command.
 *
 * @param input - The check input, scoped to "ios" or "android".
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "android", project, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  if (input.target !== "ios" && input.target !== "android") {
    throw new Error(`[native] completeness check does not apply to target "${input.target}".`);
  }
  const { target } = input;
  const id = `gen-completeness-${target}`;
  const result = input.project.getCompleteness({ target });

  if (result.status === "incomplete") {
    return {
      id,
      target,
      status: "fail",
      message: `[native] ${target} gen/ tree is missing required files: ${result.missing.join(", ")}.`,
      fixIt: `native clean --target ${target}`
    };
  }
  if (result.status === "not-initialized") {
    return {
      id,
      target,
      status: "pass",
      message: `[native] ${target} gen/ tree is not initialized yet — will init on first build.`
    };
  }
  if (result.status === "complete") {
    return {
      id,
      target,
      status: "pass",
      message: `[native] ${target} gen/ tree is complete (${input.project.getRequiredFiles({ target }).length} required files present).`
    };
  }
  return {
    id,
    target,
    status: "pass",
    message: `[native] ${target} has no gen/ tree (not applicable).`
  };
}

/** Mobile gen/ tree completeness — ios/android only. */
export const completenessCheck: Check = {
  id: "gen-completeness",
  /**
   * Whether this check applies — only the mobile targets have a gen/ tree.
   *
   * @param target - The candidate scope.
   * @returns Whether `gen-completeness` applies to `target`.
   * @example
   * ```ts
   * completenessCheck.appliesTo("android", global); // true
   * ```
   */
  appliesTo: target => target === "ios" || target === "android",
  run
};
