/**
 * @file project plugin generator — tauri.conf.json (identity, build wiring, bundle
 * metadata, Apple signing, plugin blocks).
 */
import path from "node:path";
import type { TauriConfFragment } from "../types";
import { entitlementsPath } from "./entitlements";
import { relativeToTauriRoot } from "./paths";
import type { Artifact, GeneratorInput } from "./types";

/**
 * The icon set `tauri icon` writes into `src-tauri/icons`. Tauri reads `bundle.icon` at
 * bundle time and fails when the list is empty, so it is declared here and never derived.
 */
const BUNDLE_ICONS = [
  "icons/32x32.png",
  "icons/128x128.png",
  "icons/128x128@2x.png",
  "icons/icon.icns",
  "icons/icon.ico"
];

/**
 * Drops the entries whose value is unset, so an unconfigured store/signing field is
 * ABSENT from the JSON rather than present-and-null (Tauri rejects null there).
 *
 * @param entries - Candidate key/value pairs.
 * @returns A record holding only the pairs with a defined value.
 * @example
 * ```ts
 * compact([["bundleVersion", "42"], ["developmentTeam", undefined]]); // { bundleVersion: "42" }
 * ```
 */
function compact(
  entries: ReadonlyArray<readonly [string, string | undefined]>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Builds the `bundle` block — icon set, optional store metadata, and the Apple signing
 * identifiers. `iOS` and `android` always exist (Tauri expects the keys); `macOS` appears
 * only when something is actually configured for it.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns The `bundle` object for tauri.conf.json.
 * @example
 * ```ts
 * buildBundle({ global, target: "macos", capabilities: [] });
 * ```
 */
function buildBundle(input: GeneratorInput) {
  const { app, signing } = input.global;
  const apple = signing.apple ?? {};

  const macOS = compact([
    ["signingIdentity", apple.signingIdentity],
    ["providerShortName", apple.providerShortName],
    ["entitlements", entitlementsPath(input)],
    ["minimumSystemVersion", apple.macosMinimumSystemVersion],
    ["bundleVersion", app.buildNumber]
  ]);

  return {
    active: true,
    targets: "all",
    icon: BUNDLE_ICONS,
    ...compact([["category", app.category]]),
    iOS: compact([
      ["developmentTeam", apple.teamId],
      ["minimumSystemVersion", apple.iosMinimumSystemVersion],
      ["bundleVersion", app.buildNumber]
    ]),
    ...(Object.keys(macOS).length > 0 ? { macOS } : {}),
    android: {}
  };
}

/**
 * Generates `src-tauri/tauri.conf.json` — app identity, the web build/dev wiring, the
 * bundle/signing metadata, and one `plugins.<name>` block per resolved capability (this is
 * where deep-link's scheme rides — per D-011/D-012 the whole v1 mobile-permission story is
 * conf-only). Both path-shaped fields are rebased onto `src-tauri`, which is where Tauri
 * resolves them from, and the before-commands carry an explicit `cwd` so a monorepo
 * consumer's web build runs in its own package.
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

  const plugins: Record<string, TauriConfFragment> = {};
  for (const capability of capabilities) {
    plugins[capability.name] = capability.conf;
  }

  const webRoot = path.resolve(global.web.cwd ?? ".");
  const conf = {
    productName: global.app.name,
    identifier: global.app.identifier,
    version: global.app.version ?? "0.1.0",
    build: {
      beforeDevCommand: { script: global.web.devCommand, cwd: webRoot },
      beforeBuildCommand: { script: global.web.build, cwd: webRoot },
      devUrl: global.web.devUrl,
      frontendDist: relativeToTauriRoot(global.projectDir, path.resolve(webRoot, global.web.dist))
    },
    app: {
      windows: [{ title: global.app.name }]
    },
    bundle: buildBundle(input),
    plugins
  };

  return [
    { path: "src-tauri/tauri.conf.json", content: `${JSON.stringify(conf, undefined, 2)}\n` }
  ];
}
