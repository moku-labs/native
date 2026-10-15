/**
 * @file doctor plugin — API factory: builds fresh CheckInput per (check, scope), runs every
 * applicable check in parallel, races each against `probeTimeoutMs`, and emits doctor:check
 * per check AS IT SETTLES while the returned results keep the registry order.
 */
import { spawn } from "node:child_process";
import { access, readdir as readDirectory, readFile as readFileText } from "node:fs/promises";
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

/**
 * Real (non-injected) fs facade — read-only: UTF-8 text reads (package.json, the generated
 * gradle file), existence probes and directory listings (the Android SDK and keystore).
 */
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
  readFile: path => readFileText(path, "utf8"),
  /**
   * Whether a file or directory exists; anything `access` refuses is `false`.
   *
   * @param path - Absolute or relative path.
   * @returns `true` when something exists at `path`.
   * @example
   * ```ts
   * await realFs.exists("/Users/me/.android/debug.keystore");
   * ```
   */
  exists: path =>
    access(path).then(
      () => true,
      () => false
    ),
  /**
   * Lists a directory's entry names.
   *
   * @param path - Absolute or relative directory path.
   * @returns The entry names.
   * @example
   * ```ts
   * await realFs.readdir("/Users/me/Library/Android/sdk/platforms");
   * ```
   */
  readdir: path => readDirectory(path)
};

/**
 * Creates the doctor API — parallel check registry, per-check `doctor:check` emission.
 *
 * @param ctx - Plugin context (emit doctor:check; probe seam config; global config).
 * @param deps - The project/tauri API slices the checks read (D-007).
 * @returns The `doctor` plugin's public API.
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
     * Implements {@link Api.run}.
     *
     * @param opts - See {@link Api.run}.
     * @returns See {@link Api.run}.
     */
    async run(opts) {
      const scopes: ReadonlyArray<Target | "host"> = opts?.target
        ? [opts.target]
        : [...ctx.global.targets, "host" as const];

      // Scope-major, registry order within a scope: this order is the report's order.
      const scheduled: ScheduledCheck[] = scopes.flatMap(scope =>
        CHECKS.filter(check => check.appliesTo(scope, ctx.global)).map(check => ({ check, scope }))
      );

      const results = await Promise.all(scheduled.map(entry => settleCheck(entry)));

      const report = assembleReport(results);
      ctx.log.info("doctor:run", { ok: report.ok, checkCount: results.length });
      return report;
    }
  };
}
