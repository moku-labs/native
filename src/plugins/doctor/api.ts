/**
 * @file doctor plugin — API factory.
 */
import type { Api } from "./types";

/**
 * Creates the doctor API — parallel check registry (Promise.allSettled), emits doctor:check per result.
 *
 * @param _ctx - Plugin context (require project/tauri, emit doctor:check, probe seam config).
 * @example
 * ```ts
 * const api = createDoctorApi(ctx);
 * ```
 */
export function createDoctorApi(_ctx: unknown): Api {
  throw new Error("not implemented");
}
