/**
 * @file cli plugin — state factory.
 */
import { createRenderConsole } from "./render";
import type { CliStateContext, State } from "./types";

/**
 * Creates the cli plugin's state: ONE branded console bound to the configured render seam
 * — shared by `api.ts` and `handlers.ts` so a verb and its live progress hooks write
 * through the same sink — plus empty progress bookkeeping.
 *
 * @param ctx - Minimal context (global config + this plugin's resolved config).
 * @returns The state: the shared branded console and a stopped progress clock.
 * @example
 * ```ts
 * const state = createCliState({ global, config: { renderImpl: undefined } });
 * state.ui.info("ready");
 * ```
 */
export function createCliState(ctx: CliStateContext): State {
  return {
    ui: createRenderConsole(ctx.config.renderImpl),
    progress: { startedAt: undefined }
  };
}
