/**
 * @file doctor plugin — report assembly: ok computation + settled-rejection → internal-error mapping.
 */
import type { CheckResult, DoctorReport } from "./types";

/**
 * Converts one `Promise.allSettled` outcome into a `CheckResult`, mapping a genuine
 * rejection (a check that threw instead of resolving with a status) into a synthetic
 * "fail" result — so a single broken check can never sink the whole report.
 *
 * @param outcome - The settled outcome for one check run.
 * @param fallback - The id/target to attach when the check rejected (it never produced its own result).
 * @param fallback.id - The check's stable id.
 * @param fallback.target - The scope (a real target, or "host") the check ran against.
 * @returns The check's real result, or a synthetic internal-error "fail" result.
 * @example
 * ```ts
 * const [outcome] = await Promise.allSettled([check.run(input)]);
 * toCheckResult(outcome, { id: check.id, target: "host" });
 * ```
 */
export function toCheckResult(
  outcome: PromiseSettledResult<CheckResult>,
  fallback: { id: string; target: CheckResult["target"] }
): CheckResult {
  if (outcome.status === "fulfilled") return outcome.value;
  const detail = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
  return {
    id: fallback.id,
    target: fallback.target,
    status: "fail",
    message: `[native] doctor check "${fallback.id}" failed internally: ${detail}.`
  };
}

/**
 * Assembles the final report from every completed check result. A `"warn"` status
 * never flips `ok`; any `"fail"` status does.
 *
 * @param checks - Every completed check result, in emission order.
 * @returns The aggregated report.
 * @example
 * ```ts
 * assembleReport([{ id: "node-binary", target: "host", status: "pass", message: "node v22.1.0" }]);
 * ```
 */
export function assembleReport(checks: readonly CheckResult[]): DoctorReport {
  return { ok: checks.every(result => result.status !== "fail"), checks };
}
