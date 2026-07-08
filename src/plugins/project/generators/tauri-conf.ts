/**
 * @file project plugin generator — tauri.conf.json (identity, build wiring, plugin blocks).
 */
import type { Artifact, GeneratorInput } from "./types";

/**
 * Generates `src-tauri/tauri.conf.json` — app identity, the web build/dev wiring, and
 * one `plugins.<name>` block per resolved capability (this is where deep-link's scheme
 * rides — per D-011/D-012 the whole v1 mobile-permission story is conf-only).
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns A single-artifact array for `src-tauri/tauri.conf.json`.
 * @example
 * ```ts
 * generateTauriConf({ global, target: "ios", capabilities: [] });
 * ```
 */
export function generateTauriConf(input: GeneratorInput): Artifact[] {
  const { global, capabilities } = input;

  const plugins: Record<string, unknown> = {};
  for (const capability of capabilities) {
    plugins[capability.name] = capability.conf;
  }

  const conf = {
    productName: global.app.name,
    identifier: global.app.identifier,
    version: global.app.version ?? "0.1.0",
    build: {
      beforeDevCommand: global.web.dev.command,
      beforeBuildCommand: global.web.build,
      devUrl: global.web.dev.url,
      frontendDist: global.web.dist
    },
    app: {
      windows: [{ title: global.app.name }]
    },
    bundle: {
      active: true,
      targets: "all",
      iOS: {},
      android: {}
    },
    plugins
  };

  return [
    { path: "src-tauri/tauri.conf.json", content: `${JSON.stringify(conf, undefined, 2)}\n` }
  ];
}
