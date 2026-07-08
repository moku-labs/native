/**
 * @file cli plugin — API factory (typed verbs over project/tauri/build/doctor).
 */
import type { Api } from "./types";

/**
 * Creates the cli verb surface — build/dev/doctor/clean rendered through the branded kit (MC1).
 *
 * @param _ctx - Plugin context (require all four plugins, render/confirm seams, state).
 * @example
 * ```ts
 * const api = createCliApi(ctx);
 * ```
 */
export function createCliApi(_ctx: unknown): Api {
  throw new Error("not implemented");
}
