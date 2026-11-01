/**
 * @file cli plugin — API factory: typed verbs over project/tauri/build/doctor (D-007).
 */
import process from "node:process";
import type { Target } from "../../config";
import { hostTargets } from "../../config";
import { renderBuildFailure, renderDoctorSummary, resolveConfirm } from "./render";
import type { Api, CliContext, CliDeps } from "./types";

/**
 * Resolves the default packaging target from the host platform via the framework's own
 * {@link hostTargets} table (darwin→macos, win32→windows, linux→linux — cli keeps no
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
 * @param ctx - Plugin context (global config, state, render/confirm seams).
 * @param deps - The project/tauri/build/doctor API slices the verbs delegate to (D-007).
 * @returns The `cli` plugin's public API.
 */
export function createCliApi(ctx: CliContext, deps: CliDeps): Api {
  const { build, doctor, project, tauri } = deps;
  const ui = ctx.state.ui;
  const confirm = resolveConfirm(ctx.config.confirmImpl);

  /**
   * Forwards one scrubbed dev-process output line to the render seam (D-014: the scrubbed
   * render seam tauri's `dev()` exposes specifically for cli).
   *
   * @param line - A single scrubbed output line.
   */
  function forwardDevOutput(line: string): void {
    ui.line(line);
  }

  return {
    /**
     * Implements {@link Api.build}.
     *
     * @param opts - See {@link Api.build}.
     * @returns See {@link Api.build}.
     */
    async build(opts = {}) {
      const { simulator, aab, debug, dev } = opts;

      try {
        if (opts.all) {
          await build.runAll({ simulator, aab, debug, dev });
          return;
        }
        await build.run({ target: opts.target ?? hostTarget(), simulator, aab, debug, dev });
      } catch (error) {
        renderBuildFailure(ui, error);
        throw error;
      }
    },

    /**
     * Implements {@link Api.dev}.
     *
     * @param opts - See {@link Api.dev}.
     * @returns See {@link Api.dev}.
     */
    async dev(opts = {}) {
      const target = opts.target ?? hostTarget();

      try {
        await build.prepare({ target });
      } catch (error) {
        // Same posture as `build`: the scrubbed tail is the only place the real toolchain
        // diagnostic survives, and a failed prepare is a failed build of the same tree.
        renderBuildFailure(ui, error);
        throw error;
      }

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
     * Implements {@link Api.doctor}.
     *
     * @param opts - See {@link Api.doctor}.
     * @returns See {@link Api.doctor}.
     */
    async doctor(opts = {}) {
      const report = await doctor.run({ target: opts.target });
      renderDoctorSummary(ui, report);
      return report.ok;
    },

    /**
     * Implements {@link Api.clean}.
     *
     * @param opts - See {@link Api.clean}.
     * @returns See {@link Api.clean}.
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
