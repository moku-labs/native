/**
 * @file project plugin — capability registry (5 rows) + typed resolve/isKnownCapability.
 */
import type { CapabilityConfigMap } from "../../config";
import type { RegistryRow, ResolvedCapability, TauriConfFragment } from "./types";

/**
 * The five v1 capability registry rows (spike (a), Tauri 2.9.x source-verified 2026-07-03).
 * `tray` ships as a core Tauri capability (no dedicated plugin crate/package) — it is
 * modeled here as a plugin-shaped row for registry uniformity across the pipeline; its
 * `confidence: "low"` flags that divergence from the other four real official plugins.
 */
const REGISTRY: readonly RegistryRow[] = [
  {
    name: "store",
    npmPackage: "@tauri-apps/plugin-store",
    crate: "tauri-plugin-store",
    crateRange: "^2",
    npmRange: "^2",
    rustInit: "tauri_plugin_store::Builder::default().build()",
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
    permissions: ["clipboard-manager:allow-read-text", "clipboard-manager:allow-write-text"],
    platforms: ["macos", "windows", "linux", "ios", "android"],
    confidence: "high"
  },
  {
    name: "tray",
    npmPackage: "@tauri-apps/plugin-tray",
    crate: "tauri-plugin-tray",
    crateRange: "^2",
    npmRange: "^2",
    rustInit: "",
    permissions: ["core:tray:default"],
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
    permissions: ["deep-link:default"],
    platforms: ["macos", "windows", "linux", "ios", "android"],
    confidence: "high"
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
 * if (isKnownCapability(entry.name)) resolve(entry.name);
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
 * other row contributes an empty config block.
 *
 * @param row - The registry row being resolved.
 * @param config - Optional per-capability packaging parameters from `Config["capabilities"]`.
 * @returns The plugin config fragment to place under `plugins.<name>` in tauri.conf.json.
 * @throws {Error} When resolving deep-link without a non-empty `scheme`.
 * @example
 * ```ts
 * buildConfFragment(deepLinkRow, { mode: "scheme", scheme: "myapp" }); // { schemes: ["myapp"] }
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
  return { schemes: [scheme] };
}

/**
 * Typed registry lookup — resolves a capability row against optional consumer config,
 * producing the full packaging contribution (conf fragment + the future-mechanism
 * sidecar/manifest seams, both empty for every v1 row).
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
 * Registry data consumed by `doctor`: pinned crate/npm ranges, mobile required-file
 * sets (via `requiredFiles`), and per-row confidence markers.
 *
 * @returns A frozen copy of every registry row.
 * @example
 * ```ts
 * registryRows().map(row => row.name); // ["store", "notification", ...]
 * ```
 */
export function registryRows(): ReadonlyArray<RegistryRow> {
  return REGISTRY;
}
