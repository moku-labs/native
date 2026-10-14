/**
 * @file build plugin — API factory: prepare (scaffold→codegen→icons), run (one target),
 * runAll (sequential multi-target).
 */
import { profileOf } from "./phase";
import { assertDebugTargets, runPipeline, runPrepare } from "./pipeline";
import type { Api, BuildContext, BuildDeps, BuildResult } from "./types";

/**
 * Creates the build pipeline API — `prepare` runs the three phases that make the
 * generated project buildable (what `dev` needs); `run` executes the full
 * scaffold→codegen→icons→compile→bundle→collect pipeline for one target; `runAll` repeats
 * it sequentially across targets (never `Promise.all` — all five share one Cargo
 * `target/` lock, so parallelism would only contend) and stops at the first failing
 * target (no partial-continue in v1). The two dependency APIs are resolved ONCE at the
 * wiring point and threaded through every phase as `deps`.
 *
 * @param ctx - Plugin context (global config, log, emits native:phase/native:complete).
 * @param deps - The project/tauri API slices the pipeline calls.
 * @returns The `build` plugin's public API.
 */
export function createBuildApi(ctx: BuildContext, deps: BuildDeps): Api {
  return {
    /**
     * Implements {@link Api.prepare}.
     *
     * @param opts - See {@link Api.prepare}.
     * @returns See {@link Api.prepare}.
     */
    async prepare(opts) {
      assertDebugTargets([opts.target], opts);
      await runPrepare(ctx, deps, opts.target, profileOf(opts));
    },

    /**
     * Implements {@link Api.run}.
     *
     * @param opts - See {@link Api.run}.
     * @returns See {@link Api.run}.
     */
    run(opts) {
      return runPipeline(ctx, deps, opts);
    },

    /**
     * Implements {@link Api.runAll}.
     *
     * @param opts - See {@link Api.runAll}.
     * @returns See {@link Api.runAll}.
     */
    async runAll(opts = {}) {
      const targets = opts.targets ?? ctx.global.targets;
      // Every target is checked before the first one starts: nothing is half-built (D2).
      assertDebugTargets(targets, opts);
      const results: BuildResult[] = [];
      for (const target of targets) {
        // Sequential by design (spec/03 §Overview) — all five targets share one Cargo
        // `target/` lock; Promise.all would only contend, never parallelize.
        results.push(
          await runPipeline(ctx, deps, {
            target,
            simulator: opts.simulator,
            aab: opts.aab,
            debug: opts.debug
          })
        );
      }
      return results;
    }
  };
}
