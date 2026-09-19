/**
 * @file build plugin — API factory: prepare (scaffold→codegen→icons), run (one target),
 * runAll (sequential multi-target).
 */
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { runPipeline, runPrepare } from "./pipeline";
import type { Api, BuildContext, BuildDeps, BuildResult } from "./types";

/**
 * Creates the build pipeline API — `prepare` runs the three phases that make the
 * generated project buildable (what `dev` needs, M1); `run` executes the full
 * scaffold→codegen→icons→compile→bundle→collect pipeline for one target; `runAll` repeats
 * it sequentially across targets (never `Promise.all` — all five share one Cargo
 * `target/` lock, so parallelism would only contend) and stops at the first failing
 * target (no partial-continue in v1). Both dependencies are resolved ONCE here (N3) and
 * threaded through the pipeline as `deps`.
 *
 * @param ctx - Plugin context (`require`s project/tauri, emits native:phase/native:complete).
 * @returns The `build` plugin's public API.
 * @example
 * ```ts
 * const api = createBuildApi(ctx);
 * const result = await api.run({ target: "macos" });
 * ```
 */
export function createBuildApi(ctx: BuildContext): Api {
  const deps: BuildDeps = {
    project: ctx.require(projectPlugin),
    tauri: ctx.require(tauriPlugin)
  };

  return {
    /**
     * Brings the generated project to a buildable state — scaffold, codegen, icons — and
     * stops there. `dev` calls this before handing the tree to `tauri dev`.
     *
     * @param opts - Prepare options.
     * @param opts.target - The packaging target to prepare for.
     * @returns Nothing.
     * @example
     * ```ts
     * await app.build.prepare({ target: "macos" });
     * ```
     */
    async prepare(opts) {
      await runPrepare(ctx, deps, opts.target);
    },

    /**
     * Runs the full per-target pipeline once.
     *
     * @param opts - Run options.
     * @param opts.target - The packaging target to build.
     * @param opts.simulator - iOS: build for the host's simulator arch.
     * @param opts.aab - Android: emit a store bundle instead of an apk.
     * @returns The completed pipeline's result.
     * @example
     * ```ts
     * await app.build.run({ target: "ios", simulator: true });
     * ```
     */
    run(opts) {
      return runPipeline(ctx, deps, opts);
    },

    /**
     * Runs the pipeline sequentially for every target in `opts.targets` (default:
     * `ctx.global.targets`), stopping at the first failure.
     *
     * @param opts - Run-all options.
     * @param opts.targets - The targets to build (default: every configured target).
     * @param opts.simulator - iOS: build for the host's simulator arch.
     * @param opts.aab - Android: emit a store bundle instead of an apk.
     * @returns Every completed target's result, in target order.
     * @throws {Error} Whatever the first failing target's pipeline throws.
     * @example
     * ```ts
     * await app.build.runAll();
     * ```
     */
    async runAll(opts = {}) {
      const targets = opts.targets ?? ctx.global.targets;
      const results: BuildResult[] = [];
      for (const target of targets) {
        // Sequential by design (spec/03 §Overview) — all five targets share one Cargo
        // `target/` lock; Promise.all would only contend, never parallelize.
        results.push(
          await runPipeline(ctx, deps, { target, simulator: opts.simulator, aab: opts.aab })
        );
      }
      return results;
    }
  };
}
