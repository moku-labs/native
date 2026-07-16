import { createPlugin } from "../../config";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { createDoctorApi } from "./api";
import type { CheckResult, Config } from "./types";

const defaultConfig: Config = {
  probeImpl: undefined
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
   * Wires the real plugin context into `createDoctorApi` (not a direct factory reference —
   * `DoctorContext`'s narrow `emit`/`require` types need this call's own contextual
   * inference to correctly merge this plugin's declared `events` into its own ctx type).
   *
   * @param ctx - The real plugin context (global/config/log/env/emit/require).
   * @returns The `doctor` plugin's public API.
   * @example
   * ```ts
   * api: ctx => createDoctorApi(ctx)
   * ```
   */
  api: ctx => createDoctorApi(ctx)
});
