/**
 * @file cli plugin — API factory: typed verbs over project/tauri/build/doctor (D-007).
 */
import process from "node:process";
import type { Target } from "../../config";
import { hostTargets } from "../../config";
import { buildPlugin } from "../build";
import { doctorPlugin } from "../doctor";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { renderBuildFailure, renderDoctorSummary, resolveConfirm } from "./render";
import type { Api, CliContext } from "./types";

/**
 * Resolves the default packaging target from the host platform via the framework's own
 * {@link hostTargets} table (darwin→macos, win32→windows, linux→linux — A9: cli keeps no
 * second copy). Mobile targets are never inferred: callers pass `{ target: "ios" }`.
 *
 * @param platform - `process.platform`-shaped value (injectable for cross-platform tests).
 * @returns The resolved host target.
 * @throws {Error} `[native]` when the host platform has no desktop target.
 * @example
 * ```ts
 * hostTarget(); // "macos" on darwin
 * ```
 */
export function hostTarget(platform: NodeJS.Platform = process.platform): Target {
  const target = hostTargets(platform)[0];
  if (!target) {
    throw new Error(
      `[native] No default packaging target for host platform "${platform}".\n` +
        '  Pass an explicit target, e.g. { target: "macos" }.'
    );
  }
  return target;
}

/**
 * Creates the cli verb surface — build/dev/doctor/clean. All output flows through the
 * branded kit (MC1); build/doctor progress additionally renders live via this plugin's
 * `native:phase`/`native:complete`/`doctor:check` hooks (see `handlers.ts`).
 *
 * @param ctx - Plugin context (require project/tauri/build/doctor — D-007; render/confirm seams).
 * @returns The `cli` plugin's public API.
 * @example
 * ```ts
 * const api = createCliApi(ctx);
 * await api.build({ target: "macos" });
 * ```
 */
export function createCliApi(ctx: CliContext): Api {
  const project = ctx.require(projectPlugin);
  const tauri = ctx.require(tauriPlugin);
  const build = ctx.require(buildPlugin);
  const doctor = ctx.require(doctorPlugin);
  const ui = ctx.state.ui;
  const confirm = resolveConfirm(ctx.config.confirmImpl);

  /**
   * Forwards one scrubbed dev-process output line to the render seam (D-014: the scrubbed
   * render seam tauri's `dev()` exposes specifically for cli).
   *
   * @param line - A single scrubbed output line.
   * @example
   * ```ts
   * forwardDevOutput("Local:   http://localhost:5173/");
   * ```
   */
  function forwardDevOutput(line: string): void {
    ui.line(line);
  }

  return {
    /**
     * Builds one target (default: the host target) or every configured target with
     * `{ all: true }` (which ignores any given `target`). Progress renders live through
     * the plugin's `native:phase`/`native:complete` hooks; a failure renders the scrubbed
     * stderr tail in a box before the error line (B9) and then rethrows unchanged.
     *
     * @param opts - Build options.
     * @param opts.target - The packaging target (default: the resolved host target).
     * @param opts.all - Build every configured target instead of one (ignores `target`).
     * @param opts.simulator - iOS: build for the host's simulator arch instead of a device archive.
     * @param opts.aab - Android: emit a store bundle (`.aab`) instead of an `.apk`.
     * @returns Resolves once the build (or all builds) complete.
     * @throws {Error} Whatever the pipeline throws — after rendering the failure.
     * @example
     * ```ts
     * await app.cli.build({ target: "ios", simulator: true });
     * await app.cli.build({ all: true });
     * ```
     */
    async build(opts = {}) {
      const { simulator, aab } = opts;

      try {
        if (opts.all) {
          await build.runAll({ simulator, aab });
          return;
        }
        await build.run({ target: opts.target ?? hostTarget(), simulator, aab });
      } catch (error) {
        renderBuildFailure(ui, error);
        throw error;
      }
    },

    /**
     * Runs the dev loop. Brings the generated project to a buildable state first —
     * `build.prepare` runs scaffold → codegen → icons, so `tauri dev` never meets a
     * half-generated tree (M1) — then awaits the dev handle's `ready` and `exited`. It
     * NEVER stores the handle and NEVER calls `stop()` itself (D-002); teardown is owned
     * entirely by the tauri seam's own control flow (signal handlers, process-group kill).
     *
     * @param opts - Dev options.
     * @param opts.target - Packaging target (default: the resolved host target).
     * @returns Resolves once the dev session exits cleanly.
     * @throws {Error} `[native]` when the host has no desktop target, or when the dev
     *   session exits with a non-zero code.
     * @example
     * ```ts
     * await app.cli.dev({ target: "ios" });
     * ```
     */
    async dev(opts = {}) {
      const target = opts.target ?? hostTarget();

      await build.prepare({ target });

      const handle = await tauri.dev({ target, onOutput: forwardDevOutput });
      await handle.ready;
      const exit = await handle.exited;

      // Signal-terminated exits (code: null — e.g. Ctrl-C → tauri's SIGINT group-kill, D-002)
      // are the NORMAL way a dev session stops; only a numeric non-zero code is a failure.
      if (typeof exit.code === "number" && exit.code !== 0) {
        throw new Error(
          `[native] tauri dev exited with code ${exit.code}.\n` +
            "  Check the rendered output above for the underlying error."
        );
      }
    },

    /**
     * Runs diagnosis, renders the summary, and returns whether every check passed. The
     * per-check rows (with their fix-its) print exactly once, live from this plugin's
     * `doctor:check` hook; this method adds only the counts and the verdict (M7).
     *
     * @param opts - Optional scoping.
     * @param opts.target - A single target to diagnose (default: every configured target + host).
     * @returns Whether the report is `ok` (no failing check) — the caller sets `process.exitCode`.
     * @example
     * ```ts
     * if (!(await app.cli.doctor())) process.exitCode = 1;
     * ```
     */
    async doctor(opts = {}) {
      const report = await doctor.run({ target: opts.target });
      renderDoctorSummary(ui, report);
      return report.ok;
    },

    /**
     * Cleans derived state. Without a `target`, this wipes the ENTIRE project directory —
     * gated behind a styled confirm — before delegating to `project.clean` (D-006: project
     * owns the destructive filesystem knowledge, cli is a thin delegate).
     *
     * @param opts - Clean options.
     * @param opts.target - A single target to clean (default: confirm, then wipe everything).
     * @returns Resolves once cleaning completes (or immediately, if the user declines).
     * @example
     * ```ts
     * await app.cli.clean({ target: "android" });
     * ```
     */
    async clean(opts = {}) {
      if (!opts.target) {
        const ok = await confirm(
          `Delete the entire native project directory (${ctx.global.projectDir})? This removes every target's generated state.`
        );
        if (!ok) return;
      }
      await project.clean({ target: opts.target });
    }
  };
}
