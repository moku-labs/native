/**
 * @file build plugin — API factory: run (one target) / runAll (sequential multi-target).
 */
import { runPipeline } from "./pipeline";
import type { Api, BuildContext, BuildResult } from "./types";

/**
 * Creates the build pipeline API — `run` executes the full
 * scaffold→codegen→icons→compile→bundle→collect pipeline for one target; `runAll` repeats
 * it sequentially across targets (never `Promise.all` — all five share one Cargo
 * `target/` lock, so parallelism would only contend) and stops at the first failing
 * target (no partial-continue in v1).
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
  return {
    /**
     * Runs the full per-target pipeline once.
     *
     * @param opts - Run options.
     * @param opts.target - The packaging target to build.
     * @returns The completed pipeline's result.
     * @example
     * ```ts
     * await app.build.run({ target: "android" });
     * ```
     */
    run(opts) {
      return runPipeline(ctx, opts.target);
    },

    /**
     * Runs the pipeline sequentially for every target in `opts.targets` (default:
     * `ctx.global.targets`), stopping at the first failure.
     *
     * @param opts - Run-all options.
     * @param opts.targets - The targets to build (default: every configured target).
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
        results.push(await runPipeline(ctx, target));
      }
      return results;
    }
  };
}
