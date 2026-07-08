/**
 * @file build plugin — API factory.
 */
import type { Api } from "./types";

/**
 * Creates the build pipeline API (scaffold → codegen → icons → compile → bundle → collect).
 *
 * @param _ctx - Plugin context (require project/tauri, emit native:phase/native:complete).
 * @example
 * ```ts
 * const api = createBuildApi(ctx);
 * ```
 */
export function createBuildApi(_ctx: unknown): Api {
  throw new Error("not implemented");
}
