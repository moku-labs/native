/**
 * Standard tier — sequential per-target pipeline emitting global native:phase/native:complete;
 * owns the collect phase (bundle-location table → dist-native/<target>/).
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { createBuildApi } from "./api";

export const buildPlugin = createPlugin("build", {
  depends: [projectPlugin, tauriPlugin],
  api: createBuildApi
});
