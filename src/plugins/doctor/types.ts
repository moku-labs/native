/**
 * @file doctor plugin — type definitions.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { Config as GlobalConfig, Target } from "../../config";
import type { CheckProjectApi, CheckTauriApi } from "./checks/types";

/** Structural probe seam — injectable for tests. */
export type ProbeFn = (
  cmd: string,
  args: readonly string[]
) => Promise<{ code: number; stdout: string }>;

/** doctor plugin per-plugin config (| undefined required under exactOptionalPropertyTypes). */
export type Config = {
  probeImpl?: ProbeFn | undefined;
  /** Per-check budget: a check that outruns it yields a `warn` result. Default 10_000. */
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
 * Domain context for the doctor API factory: core's `PluginCtx` over this plugin's config
 * (it has no state) and the `doctor:check` event it declares, plus `global` and the
 * `log`/`env` core APIs (MC2/MC3). No `require`: the dependency APIs are resolved once at
 * the wiring point and travel as {@link DoctorDeps}.
 */
export type DoctorContext = PluginCtx<Config, Record<string, never>, DoctorEvents> & {
  readonly global: Readonly<GlobalConfig>;
  readonly log: LogApi;
  readonly env: EnvApi;
};

/**
 * The dependency API slices the checks read — doctor depends on exactly `project` and
 * `tauri` (D-007), and each check only ever sees these narrow surfaces.
 */
export type DoctorDeps = {
  readonly project: CheckProjectApi;
  readonly tauri: CheckTauriApi;
};

/** Public API of the doctor plugin. */
export type Api = {
  /**
   * Runs every check applicable to `opts.target` (or every configured target + host checks
   * when omitted), in parallel, emitting `doctor:check` for each one as it settles. Never
   * throws on check failures — a rejected check becomes an internal-error "fail" result and a
   * check that outruns `probeTimeoutMs` becomes a "warn" result; `run()` only throws on a
   * genuine internal bug in this orchestration itself.
   *
   * @param opts - Optional scoping.
   * @param opts.target - A single real packaging target to diagnose, or every configured
   *   target + host checks when omitted.
   * @returns The aggregated report — `checks` stays in registry order regardless of the
   *   order the individual checks settled (and were emitted) in.
   * @example
   * ```ts
   * // The cli's doctor command: diagnose one target, then render the summary.
   * const report = await ctx.require(doctorPlugin).run({ target: "ios" });
   * report.ok; // false when any check failed — warnings alone keep it true
   * ```
   */
  run(opts?: { target?: Target | undefined }): Promise<DoctorReport>;
};
