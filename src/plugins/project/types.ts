/**
 * @file project plugin — type definitions.
 */
import type { LogApi } from "@moku-labs/common";
import type { CapabilityConfigMap, Config, Target } from "../../config";

/** Result of a write-if-changed generation pass. */
export type GenerateResult = { written: string[]; unchanged: string[]; skipped: string[] };

/** Mobile gen/-tree gate — completeness (required-file set), not existence (S4 refinement). */
export type CompletenessResult =
  | { status: "not-applicable" }
  | { status: "not-initialized" }
  | { status: "incomplete"; missing: readonly string[] }
  | { status: "complete" };

/** Result of the idempotent mobile patch pass (Android signing + the mobile runner command). */
export type PatchResult = { patched: string[]; unchanged: string[] };

/**
 * The absolute Node + `tauri.js` pair that replaces Tauri's own `node tauri …` build-phase
 * command — that command does not exist, so an unpatched Xcode/Android Studio build fails.
 * Supplied by the `tauri` plugin's `runner()`.
 */
export type MobileRunner = { nodePath: string; tauriJsPath: string };

/** Options for one mobile patch pass. The runner patch is skipped when `runner` is absent. */
export type PatchMobileOptions = {
  target: "ios" | "android";
  runner?: MobileRunner | undefined;
};

/** Result of a clean pass. */
export type CleanResult = { removed: readonly string[] };

/**
 * One capability registry row — packaging metadata with per-row research confidence.
 * A row is backed EITHER by a real Tauri plugin (crate + npm package + Rust init) or by
 * a core Tauri cargo feature (tray), so every plugin-only field is optional and
 * `cargoFeatures` is always present.
 */
export type RegistryRow = {
  name: keyof CapabilityConfigMap;
  npmPackage?: `@tauri-apps/plugin-${string}`;
  crate?: `tauri-plugin-${string}`;
  crateRange?: string;
  npmRange?: string;
  rustInit?: string;
  /** Cargo features this capability enables on the `tauri` dependency. */
  cargoFeatures: readonly string[];
  permissions: readonly string[];
  platforms: readonly Target[];
  confidence: "high" | "medium" | "low";
};

/** The tauri.conf.json `plugins["deep-link"]` shape — desktop and mobile are separate keys. */
export type DeepLinkConf = {
  desktop: { schemes: readonly string[] };
  mobile: ReadonlyArray<{ scheme: readonly string[]; appLink: boolean }>;
};

/** A tauri.conf.json `plugins.<name>` contribution — the union of the real v1 shapes. */
export type TauriConfFragment = Record<string, never> | DeepLinkConf;

/** An Info.ios.plist sidecar entry (src-tauri root, outside gen/) — empty for every v1 row. */
export type PlistEntry = { key: string; value: string };

/** An AndroidManifest need — empty for every v1 row (official plugins self-merge via build.rs). */
export type ManifestEntry = { parentTag: string; xml: string };

/** A capability resolved against consumer config. */
export type ResolvedCapability = RegistryRow & {
  conf: TauriConfFragment;
  sidecarPlist: readonly PlistEntry[];
  manifest: readonly ManifestEntry[];
};

/**
 * Domain context for the project plugin's API factory. This plugin has no per-plugin
 * config/state — it consumes global config only (D-005) — so this is deliberately
 * narrower than the kernel's full `PluginContext`: just `global` + the injected `log`
 * core API (MC2).
 */
export type ProjectContext = {
  readonly global: Readonly<Config>;
  readonly log: LogApi;
};

/** Public API of the project plugin. */
export type Api = {
  generate(opts: { target: Target }): Promise<GenerateResult>;
  completeness(opts: { target: Target }): CompletenessResult;
  patchMobile(opts: PatchMobileOptions): Promise<PatchResult>;
  clean(opts?: { target?: Target }): Promise<CleanResult>;
  ensureIconSource(): Promise<string>;
  resolve<K extends keyof CapabilityConfigMap>(
    name: K,
    config?: CapabilityConfigMap[K]
  ): ResolvedCapability;
  isKnownCapability(name: string): name is keyof CapabilityConfigMap;
  registryRows(): ReadonlyArray<RegistryRow>;
  requiredFiles(platform: "ios" | "android"): readonly string[];
};
