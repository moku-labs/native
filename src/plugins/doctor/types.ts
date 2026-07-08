/**
 * @file doctor plugin — type definitions.
 */
import type { Target } from "../../config";

/** Structural probe seam — injectable for tests. */
export type ProbeFn = (
  cmd: string,
  args: readonly string[]
) => Promise<{ code: number; stdout: string }>;

/** doctor plugin per-plugin config (| undefined required under exactOptionalPropertyTypes). */
export type Config = {
  probeImpl?: ProbeFn | undefined;
};

/** One completed check — also the doctor:check event payload. */
export type CheckResult = {
  id: string;
  target: Target | "host";
  status: "pass" | "warn" | "fail";
  message: string;
  fixIt?: string;
};

/** Aggregated diagnosis report (warns don't flip ok; fails do). */
export type DoctorReport = {
  ok: boolean;
  checks: readonly CheckResult[];
};

/** Public API of the doctor plugin. */
export type Api = {
  run(opts?: { target?: Target }): Promise<DoctorReport>;
};
