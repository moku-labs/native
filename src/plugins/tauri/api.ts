/**
 * @file tauri plugin — API factory.
 */
import type { Api } from "./types";

/**
 * Creates the tauri subprocess-seam API ([node, tauri.js, verb, ...] invocation — D-013).
 *
 * @param _ctx - Plugin context (config seams, state, global config, log, env).
 * @example
 * ```ts
 * const api = createTauriApi(ctx);
 * ```
 */
export function createTauriApi(_ctx: unknown): Api {
  throw new Error("not implemented");
}
