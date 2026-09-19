/**
 * @file doctor plugin — type definitions.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { EmitFn } from "@moku-labs/core";
import type { Config as GlobalConfig, RequireFn, Target } from "../../config";

/** Structural probe seam — injectable for tests. */
export type ProbeFn = (
  cmd: string,
  args: readonly string[]
) => Promise<{ code: number; stdout: string }>;

/** doctor plugin per-plugin config (| undefined required under exactOptionalPropertyTypes). */
export type Config = {
  probeImpl?: ProbeFn | undefined;
  /** Per-check budget: a check that outruns it yields a `warn` result (A4). Default 10_000. */
  probeTimeoutMs: number;
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

/** Events this plugin declares (spec/14 §2 register callback pattern). */
export type DoctorEvents = {
  "doctor:check": CheckResult;
};

/**
 * Domain context for the doctor API factory. Structural composition (mock-context.md
 * "advanced composition" case): doctor genuinely needs `require` — its two dependencies
 * are `project` and `tauri` (D-007) — alongside `global` and the `log`/`env` core APIs
 * (MC2/MC3). No `state` field: doctor has none (spec/04 §State). `RequireFn` is the
 * framework-shared mirror of core's unexported `PluginLike` (see `src/config.ts`).
 */
export type DoctorContext = {
  readonly global: Readonly<GlobalConfig>;
  readonly config: Readonly<Config>;
  readonly log: LogApi;
  readonly env: EnvApi;
  readonly emit: EmitFn<DoctorEvents>;
  readonly require: RequireFn;
};

/** Public API of the doctor plugin. */
export type Api = {
  run(opts?: { target?: Target }): Promise<DoctorReport>;
};
