/**
 * Complex tier — per-target toolchain/completeness/version-skew diagnosis via a checks/ registry.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { createDoctorApi } from "./api";
import type { CheckResult, Config } from "./types";

const defaultConfig: Config = {
  probeImpl: undefined
};

export const doctorPlugin = createPlugin("doctor", {
  depends: [projectPlugin, tauriPlugin],
  config: defaultConfig,
  // eslint-disable-next-line jsdoc/require-jsdoc
  events: register => ({
    "doctor:check": register<CheckResult>("A diagnosis check completed (cli renders these live)")
  }),
  api: createDoctorApi
});
