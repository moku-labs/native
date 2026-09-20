import { createPlugin } from "../../config";
import { buildPlugin } from "../build";
import { doctorPlugin } from "../doctor";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { createCliApi } from "./api";
import { createCliHandlers } from "./handlers";
import { createLogSink } from "./render";
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
   * Swaps the framework's default log sink for the branded one: once a CLI verb owns the
   * terminal, every `ctx.log` record renders as a branded line through this plugin's own
   * console instead of printing raw `{ level, event, data, ts }` objects between the
   * branded lines. Debug detail (a raw `tauri info` dump, for one) stays in the in-memory
   * trace.
   *
   * @param ctx - The real plugin context (log core API + this plugin's state).
   * @example
   * ```ts
   * onInit: ctx => { ctx.log.clearSinks(); ctx.log.addSink(createLogSink(ctx.state.ui)); }
   * ```
   */
  onInit: ctx => {
    ctx.log.clearSinks();
    ctx.log.addSink(createLogSink(ctx.state.ui));
  },
  /**
   * Wires the real plugin context into `createCliApi`, resolving cli's four dependency APIs
   * here, where core's own `ctx.require` types them.
   *
   * @param ctx - The real plugin context (global/config/state/require).
   * @returns The `cli` plugin's public API.
   * @example
   * ```ts
   * api: ctx => createCliApi(ctx, { build: ctx.require(buildPlugin), ... })
   * ```
   */
  api: ctx =>
    createCliApi(ctx, {
      project: ctx.require(projectPlugin),
      tauri: ctx.require(tauriPlugin),
      build: ctx.require(buildPlugin),
      doctor: ctx.require(doctorPlugin)
    }),
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
