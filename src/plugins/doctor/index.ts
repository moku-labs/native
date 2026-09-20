import { createPlugin } from "../../config";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { createDoctorApi } from "./api";
import type { CheckResult, Config } from "./types";

const defaultConfig: Config = {
  probeImpl: undefined,
  probeTimeoutMs: 10_000
};

/**
 * Complex tier — per-target toolchain/completeness/version-skew diagnosis via a checks/ registry.
 * Emits `doctor:check` per completed check (cli renders these live).
 *
 * @see README.md
 * @example
 * ```ts
 * const app = createApp({ plugins: [projectPlugin, tauriPlugin, doctorPlugin] });
 * ```
 */
export const doctorPlugin = createPlugin("doctor", {
  depends: [projectPlugin, tauriPlugin],
  config: defaultConfig,
  // eslint-disable-next-line jsdoc/require-jsdoc
  events: register => ({
    "doctor:check": register<CheckResult>("A diagnosis check completed (cli renders these live)")
  }),
  /**
   * Wires the real plugin context into `createDoctorApi`, resolving doctor's two dependency
   * APIs here, where core's own `ctx.require` types them.
   *
   * @param ctx - The real plugin context (global/config/log/env/emit/require).
   * @returns The `doctor` plugin's public API.
   * @example
   * ```ts
   * api: ctx => createDoctorApi(ctx, { project: ctx.require(projectPlugin), ... })
   * ```
   */
  api: ctx =>
    createDoctorApi(ctx, {
      project: ctx.require(projectPlugin),
      tauri: ctx.require(tauriPlugin)
    })
});
