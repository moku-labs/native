/**
 * @file project plugin — capability registry (8 rows), typed resolve/isKnownCapability, and
 * the one pass that composes the configured capabilities for a target and profile.
 */
import type { BuildProfile, CapabilityConfigMap, Config, Target } from "../../config";
import type { RegistryRow, ResolvedCapability, TauriConfFragment } from "./types";

/**
 * The eight capability registry rows (the first five spike (a), Tauri 2.9.x
 * source-verified 2026-07-03; `back` and `haptics` against Tauri 2.12.1). Five rows are
 * backed by a real official Tauri plugin (crate + npm package + Rust init). `tray` is a
 * core Tauri CARGO FEATURE — it carries no crate, no npm package and no Rust init, only
 * `cargoFeatures: ["tray-icon"]`, and its `confidence: "low"` flags that divergence.
 * `back` is core permissions alone: its whole API ships in `@tauri-apps/api/app`.
 * `shell` is the plugin crate this framework generates itself (`generators/shell`), linked
 * by path; its `confidence: "medium"` flags that it is verified on one device only.
 */
const REGISTRY: readonly RegistryRow[] = [
  {
    name: "store",
    npmPackage: "@tauri-apps/plugin-store",
    crate: "tauri-plugin-store",
    crateRange: "^2",
    npmRange: "^2",
    rustInit: "tauri_plugin_store::Builder::default().build()",
    cargoFeatures: [],
    permissions: ["store:default"],
    platforms: ["macos", "windows", "linux", "ios", "android"],
    confidence: "high"
  },
  {
    name: "notification",
    npmPackage: "@tauri-apps/plugin-notification",
    crate: "tauri-plugin-notification",
    crateRange: "^2",
    npmRange: "^2",
    rustInit: "tauri_plugin_notification::init()",
    cargoFeatures: [],
    permissions: ["notification:default"],
    platforms: ["macos", "windows", "linux", "ios", "android"],
    confidence: "high"
  },
  {
    name: "clipboard-manager",
    npmPackage: "@tauri-apps/plugin-clipboard-manager",
    crate: "tauri-plugin-clipboard-manager",
    crateRange: "^2",
    npmRange: "^2",
    rustInit: "tauri_plugin_clipboard_manager::init()",
    cargoFeatures: [],
    permissions: ["clipboard-manager:allow-read-text", "clipboard-manager:allow-write-text"],
    platforms: ["macos", "windows", "linux", "ios", "android"],
    confidence: "high"
  },
  {
    name: "tray",
    // No crate, no npm package, no Rust init: tray is a core Tauri cargo FEATURE.
    cargoFeatures: ["tray-icon"],
    // A tray needs more than `core:tray:default`: building the icon calls `Image`, the
    // menu calls `Menu`, and `@moku-labs/system` defaults the icon to `defaultWindowIcon()`,
    // whose command `plugin:app|default_window_icon` is NOT in `core:default` — without the
    // explicit grant a real shell rejects it with "not allowed by ACL". The menu, image and
    // resources ids are already inside `core:default`; they are spelled out anyway so the
    // row documents the whole surface tray actually touches.
    permissions: [
      "core:tray:default",
      "core:menu:default",
      "core:image:default",
      "core:resources:default",
      "core:app:allow-default-window-icon"
    ],
    // Desktop-only (spike a) — tray has no mobile packaging artifact, so it is filtered
    // out of every mobile target-set purely by this platforms list.
    platforms: ["macos", "windows", "linux"],
    confidence: "low"
  },
  {
    name: "deep-link",
    npmPackage: "@tauri-apps/plugin-deep-link",
    crate: "tauri-plugin-deep-link",
    crateRange: "^2",
    npmRange: "^2",
    rustInit: "tauri_plugin_deep_link::init()",
    cargoFeatures: [],
    permissions: ["deep-link:default"],
    platforms: ["macos", "windows", "linux", "ios", "android"],
    confidence: "high"
  },
  {
    name: "back",
    // No crate, no npm package, no Rust init: `onBackButtonPress` and `exit` ship in
    // `@tauri-apps/api/app` itself. The press listener's permissions are already inside
    // `core:default`; `exit` is not even in `core:app:default`, so it is granted here.
    cargoFeatures: [],
    permissions: ["core:app:allow-exit"],
    // Android-only: the hardware back button exists only there, so the row is filtered out
    // of every other target-set purely by this platforms list (as tray is from mobile).
    platforms: ["android"],
    confidence: "high"
  },
  {
    name: "haptics",
    npmPackage: "@tauri-apps/plugin-haptics",
    crate: "tauri-plugin-haptics",
    crateRange: "^2",
    npmRange: "^2",
    rustInit: "tauri_plugin_haptics::init()",
    cargoFeatures: [],
    // The plugin ships no default permission set, so each command is granted by name.
    // No manifest entry either: the plugin merges `android.permission.VIBRATE` itself.
    permissions: [
      "haptics:allow-impact-feedback",
      "haptics:allow-notification-feedback",
      "haptics:allow-selection-feedback",
      "haptics:allow-vibrate"
    ],
    platforms: ["ios", "android"],
    confidence: "high"
  },
  {
    name: "shell",
    // The page bridge `globalThis.__MOKU_NATIVE__`: generated under projectDir, linked by
    // path, never published. Its permission set is the crate's own permissions/default.toml.
    localCrate: { name: "tauri-plugin-moku-shell", directory: "plugins/moku-shell" },
    rustInit: "tauri_plugin_moku_shell::init()",
    cargoFeatures: [],
    permissions: ["moku-shell:default"],
    // Android only while the iOS shell is deferred (Decision D6): on iOS the row is filtered
    // out like any platform-limited row, and the page has no `__MOKU_NATIVE__`.
    platforms: ["android"],
    confidence: "medium"
  }
];

const KNOWN_NAMES: readonly string[] = REGISTRY.map(row => row.name);

/**
 * Runtime narrowing guard for capability names arriving from `config.system` (plain
 * strings at compile time). Call this before passing a config-sourced name to `resolve`.
 *
 * @param name - A capability name to test against the registry.
 * @returns True (narrowing `name` to `keyof CapabilityConfigMap`) if the registry knows it.
 * @example
 * ```ts
 * isKnownCapability("store"); // true
 * isKnownCapability("camera"); // false
 * ```
 */
export function isKnownCapability(name: string): name is keyof CapabilityConfigMap {
  return KNOWN_NAMES.includes(name);
}

/**
 * Builds the `[native]`-formatted "unknown capability" error, listing every known
 * capability name so a composition-time failure is immediately actionable.
 *
 * @param name - The unrecognized capability name from `config.system`.
 * @returns A formatted, throw-ready Error.
 * @example
 * ```ts
 * if (!isKnownCapability(name)) throw unknownCapabilityError(name);
 * ```
 */
export function unknownCapabilityError(name: string): Error {
  return new Error(
    `[native] Unknown capability "${name}" in config.system.\n  Known capabilities: ${KNOWN_NAMES.join(", ")}.`
  );
}

/**
 * Validates every `config.system` entry against the registry, throwing the
 * `unknown-capability` error (with the full known-capability list) at the first
 * unrecognized name. Used at composition time by `onInit`.
 *
 * @param system - The composed `@moku-labs/system` plugin list from global config.
 * @throws {Error} When any entry name is not a known capability.
 * @example
 * ```ts
 * assertKnownCapabilities(ctx.global.system);
 * ```
 */
export function assertKnownCapabilities(system: ReadonlyArray<{ name: string }>): void {
  for (const entry of system) {
    if (!isKnownCapability(entry.name)) throw unknownCapabilityError(entry.name);
  }
}

/**
 * Builds the tauri.conf.json `plugins.<name>` contribution for a resolved row. Only
 * deep-link carries consumer-supplied config in v1 (D-011: custom-scheme-only); every
 * other row contributes an EMPTY fragment, which the tauri-conf generator drops instead
 * of writing — those plugins deserialize their config slot as `unit` and reject a map.
 *
 * @param row - The registry row being resolved.
 * @param config - Optional per-capability packaging parameters from `Config["capabilities"]`.
 * @returns The plugin config fragment to place under `plugins.<name>` in tauri.conf.json.
 * @throws {Error} When resolving deep-link without a non-empty `scheme`.
 * @example
 * ```ts
 * buildConfFragment(deepLinkRow, { mode: "scheme", scheme: "myapp" });
 * // { desktop: { schemes: ["myapp"] }, mobile: [{ scheme: ["myapp"], appLink: false }] }
 * ```
 */
function buildConfFragment(
  row: RegistryRow,
  config: CapabilityConfigMap[keyof CapabilityConfigMap] | undefined
): TauriConfFragment {
  if (row.name !== "deep-link") return {};

  const scheme = config && "scheme" in config ? config.scheme : undefined;
  if (!scheme) {
    throw new Error(
      '[native] deep-link capability requires a non-empty scheme.\n  Set capabilities["deep-link"] = { mode: "scheme", scheme: "yourscheme" }.'
    );
  }
  // The plugin reads desktop and mobile from separate keys; `appLink: false` keeps v1
  // custom-scheme-only (D-011) — universal links would need an associated-domains file.
  return { desktop: { schemes: [scheme] }, mobile: [{ scheme: [scheme], appLink: false }] };
}

/**
 * Typed registry lookup — resolves a capability row against optional consumer config,
 * producing the full packaging contribution (conf fragment + the sidecar/manifest seams,
 * both empty for every row today).
 *
 * @param name - A capability name known at compile time (`keyof CapabilityConfigMap`).
 * @param config - Optional per-capability packaging parameters.
 * @returns The resolved capability (registry row + conf/sidecarPlist/manifest).
 * @throws {Error} When `name` is not in the registry, or deep-link is missing a scheme.
 * @example
 * ```ts
 * resolve("deep-link", { mode: "scheme", scheme: "myapp" });
 * ```
 */
export function resolve<K extends keyof CapabilityConfigMap>(
  name: K,
  config?: CapabilityConfigMap[K]
): ResolvedCapability {
  const row = REGISTRY.find(candidate => candidate.name === name);
  if (!row) throw unknownCapabilityError(name);
  return {
    ...row,
    conf: buildConfFragment(row, config),
    sidecarPlist: [],
    manifest: []
  };
}

/**
 * Resolves every capability configured on `config.system` against the registry, scoped to
 * rows whose `platforms` include the target (D-012: the whole packaging composition is
 * data-driven from this one pass). Naming a capability in `config.system` is the ONE way to
 * compose it — `config.capabilities` only carries parameters. The debug profile is the one
 * exception: on android it composes `shell` even unnamed, because console forwarding and
 * WebView debugging live there (Decision D3).
 *
 * @param global - Frozen global framework config.
 * @param target - The packaging target being generated for.
 * @param profile - The build profile; `"store"` when omitted.
 * @returns The resolved capabilities applicable to this target, in `config.system` order,
 *   the implied shell last.
 * @throws {Error} When `config.system` names a capability the registry doesn't know.
 * @example
 * ```ts
 * resolveConfiguredCapabilities({ ...config, system: [{ name: "store" }] }, "android", "debug").map(row => row.name);
 * // ["store", "shell"]
 * ```
 */
export function resolveConfiguredCapabilities(
  global: Readonly<Config>,
  target: Target,
  profile: BuildProfile = "store"
): ResolvedCapability[] {
  const resolved: ResolvedCapability[] = [];
  for (const entry of global.system) {
    if (!isKnownCapability(entry.name)) throw unknownCapabilityError(entry.name);
    const capability = resolve(entry.name, global.capabilities[entry.name]);
    // A row this target does not support is left out, not an error.
    if (!capability.platforms.includes(target)) continue;
    resolved.push(capability);
  }

  // The debug profile on android needs the shell even when `config.system` does not name it.
  const impliesShell = profile === "debug" && target === "android";
  const shellMissing = !resolved.some(capability => capability.name === "shell");
  if (impliesShell && shellMissing) resolved.push(resolve("shell", global.capabilities.shell));
  return resolved;
}

/**
 * Registry data consumed by `doctor`: pinned crate/npm ranges, mobile required-file
 * sets (via `requiredFiles`), and per-row confidence markers.
 *
 * @returns A fresh copy of every registry row — callers can never mutate the registry.
 * @example
 * ```ts
 * registryRows().map(row => row.name);
 * // ["store", "notification", "clipboard-manager", "tray", "deep-link", "back", "haptics", "shell"]
 * ```
 */
export function registryRows(): ReadonlyArray<RegistryRow> {
  return REGISTRY.map(row => ({ ...row }));
}
