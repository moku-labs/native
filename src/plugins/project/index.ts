import { createPlugin } from "../../config";
import { createProjectApi, validateProjectConfig } from "./api";

/**
 * Complex tier — capability registry + .moku/tauri generators + write-if-changed writer +
 * mobile init-once-then-patch (Android signing only in v1) + clean.
 *
 * @see README.md
 * @example
 * ```ts
 * const app = createApp({ plugins: [projectPlugin] });
 * ```
 */
export const projectPlugin = createPlugin("project", {
  api: createProjectApi,
  /**
   * Validates consumer config at composition time (spec/11 Part 3).
   *
   * @param ctx - Plugin context carrying the frozen global config.
   * @example
   * ```ts
   * onInit: ctx => validateProjectConfig(ctx.global)
   * ```
   */
  onInit: ctx => {
    validateProjectConfig(ctx.global);
  }
});
