/**
 * Standard tier — typed verb surface (build/dev/doctor/clean), branded rendering (MC1),
 * live progress via hooks. dev() awaits tauri's DevHandle but never holds it (D-002).
 *
 * @see README.md
 */
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

export const cliPlugin = createPlugin("cli", {
  depends: [projectPlugin, tauriPlugin, buildPlugin, doctorPlugin],
  config: defaultConfig,
  createState: createCliState,
  api: createCliApi,
  hooks: createCliHandlers
});
