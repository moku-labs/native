/**
 * @file project plugin — composition-time validation of the global config. Runs in the
 * plugin's `onInit`, so a misconfigured app fails at `createApp` with a `[native]` fix-it
 * instead of deep inside `tauri build`.
 */
import type { Config } from "../../config";
import { assertKnownCapabilities } from "./registry";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/i;

/**
 * Validates the global config at composition time — throws `[native]`-formatted errors
 * for missing app identity, missing web wiring, unknown `config.system` names, or a
 * `deep-link` composition missing its required scheme.
 *
 * @param global - Frozen global framework config.
 * @throws {Error} When app identity, web wiring, system names, or deep-link config are invalid.
 * @example
 * ```ts
 * validateProjectConfig(ctx.global);
 * ```
 */
export function validateProjectConfig(global: Readonly<Config>): void {
  // Stanza 1 — identity and web wiring. Every field below lands verbatim in
  // tauri.conf.json, where a missing value fails deep inside `tauri build` instead.
  if (!global.app.name) {
    throw new Error(
      "[native] app.name is required.\n  Set config.app.name to your app's display name."
    );
  }
  if (!IDENTIFIER_PATTERN.test(global.app.identifier)) {
    throw new Error(
      `[native] app.identifier "${global.app.identifier}" is not a valid reverse-DNS identifier.\n  Use a reverse-DNS identifier such as "com.example.myapp".`
    );
  }
  if (!global.web.build) {
    throw new Error(
      "[native] web.build is required.\n  Set config.web.build to the command that builds your web assets."
    );
  }
  if (!global.web.devCommand) {
    throw new Error(
      "[native] web.devCommand is required.\n  Set config.web.devCommand to the command that starts your dev server."
    );
  }
  if (!global.web.devUrl) {
    throw new Error(
      "[native] web.devUrl is required.\n  Set config.web.devUrl to your dev server's URL."
    );
  }
  if (!global.web.dist) {
    throw new Error(
      "[native] web.dist is required.\n  Set config.web.dist to your web build's output directory."
    );
  }

  // Stanza 2 — the composed capability set. Names are validated against the registry, and
  // deep-link is the one row that cannot be packaged from its defaults alone.
  assertKnownCapabilities(global.system);

  const usesDeepLink = global.system.some(entry => entry.name === "deep-link");
  if (usesDeepLink && !global.capabilities["deep-link"]?.scheme) {
    throw new Error(
      '[native] deep-link is composed in config.system but capabilities["deep-link"].scheme is missing.\n  Set capabilities["deep-link"] = { mode: "scheme", scheme: "yourscheme" }.'
    );
  }
}
