/**
 * @file project plugin generator — tauri.conf.json (identity, build wiring, bundle
 * metadata, Apple signing, the Android versionCode, plugin blocks).
 */
import path from "node:path";
import type { ResolvedCapability, TauriConfFragment } from "../types";
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
 * The iOS deployment target used when `signing.apple.iosMinimumSystemVersion` is unset.
 * Tauri's own default is 14.0, which Xcode 27 rejects outright ("the range of supported
 * deployment target versions is 15.0 to 27.0.x", xcodebuild exit 65), so every iOS build
 * on a current Xcode failed until the person found and set this value themselves.
 */
export const DEFAULT_IOS_MINIMUM_SYSTEM_VERSION = "15.0";

/** A whole number without leading zeros: the only shape Gradle's `versionCode` takes. */
const VERSION_CODE_PATTERN = /^[1-9]\d*$/;

/** The highest `versionCode` Google Play accepts. */
const MAX_VERSION_CODE = 2_100_000_000;

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
 * Reads the Android `versionCode` from `app.buildNumber`, as the JSON number Tauri asks for.
 * Checked here and not at composition: `"1.0.3"` stays a legal macOS/iOS bundle version, and
 * `build.run({ targets })` may name a target outside `config.targets`.
 *
 * @param input - Frozen global config + the target being generated for.
 * @returns The `versionCode` on android with a build number set, undefined otherwise.
 * @throws {Error} `[native]` on android when the build number is not a whole number from 1
 *   to 2100000000.
 * @example
 * ```ts
 * androidVersionCode({ global: { app: { buildNumber: "42" } }, target: "android" }); // 42
 * ```
 */
function androidVersionCode(input: GeneratorInput): number | undefined {
  const { buildNumber } = input.global.app;
  if (input.target !== "android" || buildNumber === undefined) return undefined;

  const versionCode = Number(buildNumber);
  if (VERSION_CODE_PATTERN.test(buildNumber) && versionCode <= MAX_VERSION_CODE) return versionCode;

  throw new Error(
    `[native] app.buildNumber "${buildNumber}" is not a valid Android versionCode.\n  Use a whole number from 1 to ${MAX_VERSION_CODE}, such as "42".`
  );
}

/**
 * Whether a platform block carries anything worth writing.
 *
 * @param block - A compacted block.
 * @returns True when the block has at least one key.
 * @example
 * ```ts
 * hasEntries({}); // false
 * ```
 */
function hasEntries(block: Record<string, string>): boolean {
  return Object.keys(block).length > 0;
}

/**
 * Builds the `bundle` block — icon set, optional store metadata, and the signing
 * identifiers. `iOS` and `android` always exist (Tauri expects the keys), `iOS` always
 * carries a deployment target Xcode accepts, and `android` carries a `versionCode` on an
 * android build with a build number; `macOS` and `windows` appear only when something is
 * actually configured for them.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns The `bundle` object for tauri.conf.json.
 * @example
 * ```ts
 * buildBundle({ global: { app: { name: "App" }, signing: {} }, target: "ios", capabilities: [], profile: "store" }).iOS;
 * // { minimumSystemVersion: "15.0" }
 * ```
 */
function buildBundle(input: GeneratorInput) {
  // Each platform block holds only what is configured.
  const { app, signing } = input.global;
  const apple = signing.apple ?? {};
  const windows = compact([["certificateThumbprint", signing.windows?.certificateThumbprint]]);
  const versionCode = androidVersionCode(input);

  const macOS = compact([
    ["signingIdentity", apple.signingIdentity],
    ["providerShortName", apple.providerShortName],
    ["entitlements", entitlementsPath(input)],
    ["minimumSystemVersion", apple.macosMinimumSystemVersion],
    ["bundleVersion", app.buildNumber]
  ]);

  // `iOS` and `android` always exist; `macOS` and `windows` only with something in them.
  return {
    active: true,
    targets: "all",
    icon: BUNDLE_ICONS,
    ...compact([["category", app.category]]),
    iOS: compact([
      ["developmentTeam", apple.teamId],
      ["minimumSystemVersion", apple.iosMinimumSystemVersion ?? DEFAULT_IOS_MINIMUM_SYSTEM_VERSION],
      ["bundleVersion", app.buildNumber]
    ]),
    ...(hasEntries(macOS) ? { macOS } : {}),
    ...(hasEntries(windows) ? { windows } : {}),
    android: versionCode === undefined ? {} : { versionCode }
  };
}

/**
 * Builds the `plugins` block — one `plugins.<name>` key per capability that actually
 * carries config.
 *
 * A capability whose Tauri plugin takes NO config (store, notification,
 * clipboard-manager) deserializes its config slot as `unit`, so an empty map there is a
 * TYPE error that aborts the app at startup:
 * `PluginInitialization("clipboard-manager", "… invalid type: map, expected unit")`. An
 * empty fragment therefore produces no key at all. The `plugins` object itself always
 * exists — Tauri accepts it empty.
 *
 * @param capabilities - Capabilities resolved and platform-filtered for this target.
 * @returns The `plugins` object for tauri.conf.json, keyed by capability name.
 * @example
 * ```ts
 * buildPlugins([resolve("store"), resolve("deep-link", { mode: "scheme", scheme: "app" })]);
 * // { "deep-link": { desktop: …, mobile: … } } — store contributes no key
 * ```
 */
function buildPlugins(
  capabilities: readonly ResolvedCapability[]
): Record<string, TauriConfFragment> {
  const plugins: Record<string, TauriConfFragment> = {};
  for (const capability of capabilities) {
    if (Object.keys(capability.conf).length > 0) plugins[capability.name] = capability.conf;
  }
  return plugins;
}

/**
 * Generates `src-tauri/tauri.conf.json` — app identity, the web build/dev wiring, with
 * `removeUnusedCommands` in the store profile only (a debug page may call what a store
 * page does not), the main window (its title, plus `app.backgroundColor` when set), the
 * bundle/signing metadata, and a `plugins.<name>` block per CONFIGURED capability (see
 * {@link buildPlugins}; this is where deep-link's scheme rides — per D-011/D-012 the whole
 * v1 mobile-permission story is conf-only). Both path-shaped fields are rebased onto
 * `src-tauri`, which is where Tauri resolves them from, and the before-commands carry an
 * explicit `cwd` so a monorepo consumer's web build runs in its own package.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns A single-artifact array for `src-tauri/tauri.conf.json`.
 * @throws {Error} `[native]` on android when `app.buildNumber` is not a valid `versionCode`.
 * @example
 * ```ts
 * generateTauriConf({ global, target: "ios", capabilities: [], profile: "store" })[0]?.path;
 * // "src-tauri/tauri.conf.json"
 * ```
 */
export function generateTauriConf(input: GeneratorInput): Artifact[] {
  const { global, capabilities } = input;
  const webRoot = path.resolve(global.web.cwd ?? ".");
  const conf = {
    productName: global.app.name,
    identifier: global.app.identifier,
    version: global.app.version ?? "0.1.0",
    build: {
      beforeDevCommand: { script: global.web.devCommand, cwd: webRoot },
      beforeBuildCommand: { script: global.web.build, cwd: webRoot },
      devUrl: global.web.devUrl,
      frontendDist: relativeToTauriRoot(global.projectDir, path.resolve(webRoot, global.web.dist)),
      ...(input.profile === "store" ? { removeUnusedCommands: true } : {})
    },
    app: {
      // The first entry carries no `label`, so tauri names it `main` — the window the
      // capability file and the generated lib.rs safe-area hook both address.
      windows: [
        { title: global.app.name, ...compact([["backgroundColor", global.app.backgroundColor]]) }
      ]
    },
    bundle: buildBundle(input),
    plugins: buildPlugins(capabilities)
  };

  return [
    { path: "src-tauri/tauri.conf.json", content: `${JSON.stringify(conf, undefined, 2)}\n` }
  ];
}
