/**
 * @file doctor plugin — API factory: builds fresh CheckInput per (check, scope), runs every
 * applicable check in parallel, races each against `probeTimeoutMs`, and emits doctor:check
 * per check AS IT SETTLES while the returned results keep the registry order.
 */
import { spawn } from "node:child_process";
import { readFile as readFileText } from "node:fs/promises";
import type { Target } from "../../config";
import { CHECKS } from "./checks";
import type { Check, CheckInput, FsFacade } from "./checks/types";
import { assembleReport, toCheckResult } from "./report";
import type { Api, CheckResult, DoctorContext, DoctorDeps, ProbeFn } from "./types";

/** One (check, scope) pair scheduled for this run — the registry order is the result order. */
type ScheduledCheck = { check: Check; scope: Target | "host" };

/**
 * Builds the real (non-injected) probe seam, bound to the configured timeout budget so a
 * hung binary is killed by the child process itself instead of leaking. Merges
 * stdout+stderr into one buffer (presence/version parsing never needs them separated).
 *
 * @param timeoutMs - Budget handed to `spawn` as its `timeout` option.
 * @returns A probe that spawns the binary and resolves with its exit code and output.
 * @example
 * ```ts
 * const probe = createRealProbe(10_000);
 * await probe("node", ["--version"]);
 * ```
 */
function createRealProbe(timeoutMs: number): ProbeFn {
  return (cmd, args) =>
    new Promise(resolve => {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", () => resolve({ code: 1, stdout: output }));
      child.on("close", code => resolve({ code: code ?? 1, stdout: output }));
    });
}

/**
 * Races one running check against the configured budget — a check that outruns it yields a
 * `warn` result (never a `fail`: a slow toolchain probe is not a broken toolchain).
 *
 * @param pending - The already-running check.
 * @param budgetMs - The per-check budget in milliseconds.
 * @param fallback - The id/target the timeout result carries.
 * @param fallback.id - The check's stable id.
 * @param fallback.target - The scope the check ran against.
 * @returns The check's own result, or the synthetic timeout `warn` result.
 * @example
 * ```ts
 * await raceTimeout(check.run(input), 10_000, { id: check.id, target: "ios" });
 * ```
 */
function raceTimeout(
  pending: Promise<CheckResult>,
  budgetMs: number,
  fallback: { id: string; target: CheckResult["target"] }
): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckResult>(resolve => {
    timer = setTimeout(
      () =>
        resolve({
          id: fallback.id,
          target: fallback.target,
          status: "warn",
          message: `[native] doctor check "${fallback.id}" timed out.`,
          fixIt: "re-run `native doctor`, or raise pluginConfigs.doctor.probeTimeoutMs"
        }),
      budgetMs
    );
  });

  return Promise.race([pending, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** Real (non-injected) fs facade — UTF-8 text reads only (every check only reads package.json). */
const realFs: FsFacade = {
  /**
   * Reads a file as UTF-8 text.
   *
   * @param path - Absolute or relative file path.
   * @returns The file's text content.
   * @example
   * ```ts
   * await realFs.readFile("/repo/package.json");
   * ```
   */
  readFile: path => readFileText(path, "utf8")
};

/**
 * Creates the doctor API — parallel check registry, per-check `doctor:check` emission.
 *
 * @param ctx - Plugin context (emit doctor:check; probe seam config; global config).
 * @param deps - The project/tauri API slices the checks read (D-007).
 * @returns The `doctor` plugin's public API.
 * @example
 * ```ts
 * const api = createDoctorApi(ctx, { project, tauri });
 * const report = await api.run({ target: "ios" });
 * ```
 */
export function createDoctorApi(ctx: DoctorContext, deps: DoctorDeps): Api {
  const probe = ctx.config.probeImpl ?? createRealProbe(ctx.config.probeTimeoutMs);

  /**
   * Builds fresh `CheckInput` for one `(check, scope)` pair and runs it. Async so a check
   * that throws synchronously still becomes a rejection the caller can map.
   *
   * @param check - The check to run.
   * @param scope - The real packaging target, or "host" for host-scoped checks.
   * @returns The completed check result (rejects if the check itself throws).
   * @example
   * ```ts
   * await runCheck(nodeCheck, "host");
   * ```
   */
  const runCheck = async (check: Check, scope: Target | "host"): Promise<CheckResult> => {
    const input: CheckInput = {
      target: scope,
      global: ctx.global,
      probe,
      fs: realFs,
      env: ctx.env,
      project: deps.project,
      tauri: deps.tauri
    };
    return check.run(input);
  };

  /**
   * Runs one scheduled check to a result (timeout and rejection both mapped), then emits
   * `doctor:check` for it immediately — the cli renders rows live, so emission happens at
   * settle time, never batched at the end of the run.
   *
   * @param entry - The scheduled (check, scope) pair.
   * @returns The check's completed result.
   * @example
   * ```ts
   * await settleCheck({ check: nodeCheck, scope: "host" });
   * ```
   */
  const settleCheck = async (entry: ScheduledCheck): Promise<CheckResult> => {
    // The check's own per-scope id, so a synthetic result lines up with the live rows the cli
    // already printed — never the bare module id.
    const fallback = {
      id: entry.check.resultId?.(entry.scope) ?? entry.check.id,
      target: entry.scope
    };
    const result = await raceTimeout(
      runCheck(entry.check, entry.scope),
      ctx.config.probeTimeoutMs,
      fallback
    ).catch((error: unknown) => toCheckResult({ status: "rejected", reason: error }, fallback));

    ctx.emit("doctor:check", result);
    return result;
  };

  return {
    /**
     * Runs every check applicable to `opts.target` (or every configured target + host
     * checks when omitted), in parallel. Never throws on check failures — a rejected check
     * becomes an internal-error "fail" result and a check that outruns `probeTimeoutMs`
     * becomes a "warn" result; `run()` only throws on a genuine internal bug in this
     * orchestration itself.
     *
     * @param opts - Optional scoping.
     * @param opts.target - A single real packaging target to diagnose, or every configured
     *   target + host checks when omitted.
     * @returns The aggregated report — `checks` stays in registry order regardless of the
     *   order the individual checks settled (and were emitted) in.
     * @example
     * ```ts
     * const report = await app.doctor.run({ target: "ios" });
     * if (!report.ok) process.exitCode = 1;
     * ```
     */
    async run(opts) {
      const scopes: ReadonlyArray<Target | "host"> = opts?.target
        ? [opts.target]
        : [...ctx.global.targets, "host" as const];

      const scheduled: ScheduledCheck[] = [];
      for (const scope of scopes) {
        for (const check of CHECKS) {
          if (check.appliesTo(scope, ctx.global)) {
            scheduled.push({ check, scope });
          }
        }
      }

      const results = await Promise.all(scheduled.map(entry => settleCheck(entry)));

      const report = assembleReport(results);
      ctx.log.info("doctor:run", { ok: report.ok, checkCount: results.length });
      return report;
    }
  };
}
