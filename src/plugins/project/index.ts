import { createPlugin } from "../../config";
import { createProjectApi } from "./api";
import { validateProjectConfig } from "./validate";

/**
 * Complex tier — capability registry + generators/ + write-if-changed writer + the mobile/
 * sub-domain (completeness gate, Android signing block, runner-command rewrite) + the
 * guarded clean.
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
