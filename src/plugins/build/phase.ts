/**
 * @file build plugin — phase plumbing shared by the pipeline and the compile/bundle step:
 * the run's profile and the `native:phase` emitter.
 */
import type { BuildFlavor, BuildProfile, NativePhase, Target } from "../../config";
import type { BuildContext } from "./types";

/**
 * Picks the profile a build flavour asks for: `debug` set means the debug profile, `dev` set
 * the dev one, anything else the store one. Both set name no profile and are refused here,
 * so every caller reads the refusal before its first phase.
 *
 * @param flavor - The build flavour of the run.
 * @returns `"debug"`, `"dev"` or `"store"`.
 * @throws {Error} `[native] debug and dev cannot be combined.` when both are set.
 * @example
 * ```ts
 * profileOf({ dev: true }); // "dev"
 * ```
 */
export function profileOf(flavor: BuildFlavor): BuildProfile {
  if (flavor.debug === true && flavor.dev === true) {
    throw new Error(
      "[native] debug and dev cannot be combined.\n  Build one profile: debug for the local app, dev for the store-signed test app."
    );
  }
  if (flavor.debug === true) return "debug";
  return flavor.dev === true ? "dev" : "store";
}

/**
 * Emits one `native:phase` event, omitting `durationMs`/`detail` when absent rather than
 * assigning `undefined` (D-014, `exactOptionalPropertyTypes`).
 *
 * @param ctx - The build pipeline's domain context.
 * @param target - The packaging target the phase runs for.
 * @param phase - Which pipeline phase this event reports on.
 * @param status - The phase's current status.
 * @param extra - Optional duration/detail to attach.
 * @param extra.durationMs - Elapsed time for a "done"/"error" event.
 * @param extra.detail - Human-readable detail (progress ticks, skip reasons, error text).
 */
export function emitPhase(
  ctx: BuildContext,
  target: Target,
  phase: NativePhase,
  status: "start" | "progress" | "done" | "error",
  extra?: { durationMs?: number; detail?: string }
): void {
  ctx.emit("native:phase", {
    target,
    phase,
    status,
    ...(extra?.durationMs === undefined ? {} : { durationMs: extra.durationMs }),
    ...(extra?.detail === undefined ? {} : { detail: extra.detail })
  });
}
