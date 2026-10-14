import { createPlugin } from "../../config";
import { createProjectApi } from "./api";
import { validateProjectConfig } from "./validate";

/**
 * Complex tier — capability registry + generators/ (the `tauri-plugin-moku-shell` crate
 * among them) + write-if-changed writer + the mobile/ sub-domain (completeness gate, build
 * profile patches, Android signing block, Android manifest attributes, adaptive icon inset,
 * shell link check, Xcode settings, runner-command rewrite) + the build-time orientation
 * lock + the page agent scan + the guarded clean.
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
   */
  onInit: ctx => {
    validateProjectConfig(ctx.global);
  }
});
