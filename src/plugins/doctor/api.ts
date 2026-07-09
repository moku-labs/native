/**
 * @file doctor plugin — API factory: builds fresh CheckInput per (check, scope), runs every
 * applicable check in parallel (Promise.allSettled), emits doctor:check per completed result.
 */
import { spawn } from "node:child_process";
import { readFile as readFileText } from "node:fs/promises";
import type { Target } from "../../config";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { CHECKS } from "./checks";
import type { Check, CheckInput, FsFacade } from "./checks/types";
import { assembleReport, toCheckResult } from "./report";
import type { Api, CheckResult, DoctorContext, ProbeFn } from "./types";

/**
 * Real (non-injected) probe seam — spawns the binary and merges stdout+stderr into one
 * buffer (presence/version parsing never needs them separated).
 *
 * @param cmd - Binary to spawn.
 * @param args - Arguments to pass.
 * @returns The exit code and merged output.
 * @example
 * ```ts
 * await realProbe("node", ["--version"]);
 * ```
 */
const realProbe: ProbeFn = (cmd, args) =>
  new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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
 * Creates the doctor API — parallel check registry (Promise.allSettled), emits doctor:check per result.
 *
 * @param ctx - Plugin context (require project/tauri — D-007; emit doctor:check; probe seam config).
 * @returns The `doctor` plugin's public API.
 * @example
 * ```ts
 * const api = createDoctorApi(ctx);
 * const report = await api.run({ target: "ios" });
 * ```
 */
export function createDoctorApi(ctx: DoctorContext): Api {
  const project = ctx.require(projectPlugin);
  const tauri = ctx.require(tauriPlugin);
  const probe = ctx.config.probeImpl ?? realProbe;

  /**
   * Builds fresh `CheckInput` for one `(check, scope)` pair and runs it.
   *
   * @param check - The check to run.
   * @param scope - The real packaging target, or "host" for host-scoped checks.
   * @returns The completed check result (rejects if the check itself throws).
   * @example
   * ```ts
   * await runCheck(nodeCheck, "host");
   * ```
   */
  const runCheck = (check: Check, scope: Target | "host"): Promise<CheckResult> => {
    const input: CheckInput = {
      target: scope,
      global: ctx.global,
      probe,
      fs: realFs,
      env: ctx.env,
      project: {
        requiredFiles: project.requiredFiles,
        completeness: project.completeness,
        registryRows: project.registryRows
      },
      tauri: {
        version: tauri.version
      }
    };
    return check.run(input);
  };

  return {
    /**
     * Runs every check applicable to `opts.target` (or every configured target + host
     * checks when omitted), in parallel via `Promise.allSettled`. Never throws on check
     * failures — a rejected check becomes an internal-error "fail" result instead;
     * `run()` only throws on a genuine internal bug in this orchestration itself.
     *
     * @param opts - Optional scoping.
     * @param opts.target - A single real packaging target to diagnose, or every configured
     *   target + host checks when omitted.
     * @returns The aggregated report.
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

      const scheduled: Array<{ check: Check; scope: Target | "host" }> = [];
      for (const scope of scopes) {
        for (const check of CHECKS) {
          if (check.appliesTo(scope, ctx.global)) {
            scheduled.push({ check, scope });
          }
        }
      }

      const settled = await Promise.allSettled(
        scheduled.map(entry => runCheck(entry.check, entry.scope))
      );

      const results = settled.map((outcome, index) => {
        const entry = scheduled[index];
        const result = toCheckResult(outcome, {
          id: entry?.check.id ?? "unknown",
          target: entry?.scope ?? "host"
        });
        ctx.emit("doctor:check", result);
        return result;
      });

      const report = assembleReport(results);
      ctx.log.info("doctor:run", { ok: report.ok, checkCount: results.length });
      return report;
    }
  };
}
