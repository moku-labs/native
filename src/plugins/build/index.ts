import { createPlugin } from "../../config";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { createBuildApi } from "./api";

/**
 * Standard tier — sequential per-target pipeline emitting global native:phase/native:complete;
 * owns the collect phase (bundle-location table → dist-native/<target>/).
 *
 * @see README.md
 * @example
 * ```ts
 * const app = createApp({ plugins: [projectPlugin, tauriPlugin, buildPlugin] });
 * ```
 */
export const buildPlugin = createPlugin("build", {
  depends: [projectPlugin, tauriPlugin],
  /**
   * Resolves build's two dependency APIs once, here, where core's own `ctx.require` types
   * them, and hands them to the pipeline as `deps`.
   *
   * @param ctx - The real plugin context.
   * @returns The `build` plugin's public API.
   * @example
   * ```ts
   * api: ctx => createBuildApi(ctx, { project: ctx.require(projectPlugin), ... })
   * ```
   */
  api: ctx =>
    createBuildApi(ctx, {
      project: ctx.require(projectPlugin),
      tauri: ctx.require(tauriPlugin)
    })
});
