/**
 * @file build plugin — API factory: prepare (scaffold→codegen→icons), run (one target),
 * runAll (sequential multi-target).
 */
import { assertDebugTargets, profileOf, runPipeline, runPrepare } from "./pipeline";
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
 * @example
 * ```ts
 * const api = createBuildApi(ctx, { project, tauri });
 * const result = await api.run({ target: "macos" });
 * ```
 */
export function createBuildApi(ctx: BuildContext, deps: BuildDeps): Api {
  return {
    /**
     * Implements {@link Api.prepare}: the debug-target guard, then the three phases.
     *
     * @param opts - See {@link Api.prepare}.
     * @returns See {@link Api.prepare}.
     * @example
     * ```ts
     * await api.prepare({ target: "ios", debug: true }); // rejects: asked for ios
     * ```
     */
    async prepare(opts) {
      assertDebugTargets([opts.target], opts);
      await runPrepare(ctx, deps, opts.target, profileOf(opts));
    },

    /**
     * Implements {@link Api.run}: one pipeline pass.
     *
     * @param opts - See {@link Api.run}.
     * @returns See {@link Api.run}.
     * @example
     * ```ts
     * (await api.run({ target: "android" })).outPath; // "dist-native/android"
     * ```
     */
    run(opts) {
      return runPipeline(ctx, deps, opts);
    },

    /**
     * Implements {@link Api.runAll}: the up-front guard, then one pass per target, in order.
     *
     * @param opts - See {@link Api.runAll}.
     * @returns See {@link Api.runAll}.
     * @example
     * ```ts
     * await api.runAll({ targets: ["android", "ios"], debug: true }); // rejects before any phase
     * ```
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
