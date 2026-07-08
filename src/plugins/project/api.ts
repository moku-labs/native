/**
 * @file project plugin — API factory + config validation.
 */
import type { Config } from "../../config";
import type { Api } from "./types";

/**
 * Validates the global config at composition time — throws [native]-formatted errors (spec/11 Part 3).
 *
 * @param _global - Frozen global framework config.
 * @throws {Error} When app identity, web wiring, system names, or deep-link config are invalid.
 * @example
 * ```ts
 * validateProjectConfig(ctx.global);
 * ```
 */
export function validateProjectConfig(_global: Readonly<Config>): void {
  throw new Error("not implemented");
}

/**
 * Creates the project plugin API surface.
 *
 * @param _ctx - Plugin context (global config, log, env).
 * @example
 * ```ts
 * const api = createProjectApi(ctx);
 * ```
 */
export function createProjectApi(_ctx: unknown): Api {
  throw new Error("not implemented");
}
