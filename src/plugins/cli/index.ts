import { createPlugin } from "../../config";
import { buildPlugin } from "../build";
import { doctorPlugin } from "../doctor";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { createCliApi } from "./api";
import { createCliHandlers } from "./handlers";
import { createCliState } from "./state";
import type { Config } from "./types";

const defaultConfig: Config = {
  renderImpl: undefined,
  confirmImpl: undefined
};

/**
 * Standard tier — typed verb surface (build/dev/doctor/clean), branded rendering (MC1),
 * live progress via hooks. dev() awaits tauri's DevHandle but never holds it (D-002).
 * `api`/`hooks` use the wrapper-call form (not a bare factory reference) so this call's
 * own contextual inference merges the doctor depends edge's `doctor:check` event into ctx
 * (mirrors doctor/index.ts's `api: ctx => createDoctorApi(ctx)` precedent).
 *
 * @see README.md
 * @example
 * ```ts
 * const app = createApp({ plugins: [projectPlugin, tauriPlugin, buildPlugin, doctorPlugin, cliPlugin] });
 * ```
 */
export const cliPlugin = createPlugin("cli", {
  depends: [projectPlugin, tauriPlugin, buildPlugin, doctorPlugin],
  config: defaultConfig,
  createState: createCliState,
  /**
   * Wires the real plugin context into `createCliApi` (wrapper form — see the plugin
   * JSDoc above).
   *
   * @param ctx - The real plugin context (global/config/state/require).
   * @returns The `cli` plugin's public API.
   * @example
   * ```ts
   * api: ctx => createCliApi(ctx)
   * ```
   */
  api: ctx => createCliApi(ctx),
  /**
   * Wires the real plugin context into `createCliHandlers` (wrapper form — see the plugin
   * JSDoc above).
   *
   * @param ctx - The real plugin context (global/config/state).
   * @returns The `cli` plugin's hook map.
   * @example
   * ```ts
   * hooks: ctx => createCliHandlers(ctx)
   * ```
   */
  hooks: ctx => createCliHandlers(ctx)
});
