/**
 * @file project plugin — type definitions.
 */
import type { LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { CapabilityConfigMap, Config, MobileTarget, Target, TauriRunner } from "../../config";
import type { BundleLayout } from "./layout";

/** Result of a write-if-changed generation pass. */
export type GenerateResult = {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly skipped: readonly string[];
};

/** Mobile gen/-tree gate — completeness (required-file set), not existence. */
export type CompletenessResult =
  | { status: "not-applicable" }
  | { status: "not-initialized" }
  | { status: "incomplete"; missing: readonly string[] }
  | { status: "complete" };

/** Result of the idempotent mobile patch pass (Android signing + the mobile runner command). */
export type PatchResult = {
  readonly patched: readonly string[];
  readonly unchanged: readonly string[];
};

/** Options for one mobile patch pass. The runner patch is skipped when `runner` is absent. */
export type PatchMobileOptions = {
  target: MobileTarget;
  runner?: TauriRunner | undefined;
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
 * Domain context for the project plugin's API factory: core's `PluginCtx` (this plugin
 * declares neither config nor state nor events — D-005, it reads global config only) plus
 * the two fields core composes in per framework, `global` and the `log` core API (MC2).
 */
export type ProjectContext = PluginCtx<Record<string, never>, Record<string, never>> & {
  readonly global: Readonly<Config>;
  readonly log: LogApi;
};

/** Public API of the project plugin. */
export type Api = {
  generate(opts: { target: Target }): Promise<GenerateResult>;
  getBundleLayout(opts: { target: Target }): BundleLayout;
  getCompleteness(opts: { target: Target }): CompletenessResult;
  patchMobile(opts: PatchMobileOptions): Promise<PatchResult>;
  clean(opts?: { target?: Target | undefined }): Promise<CleanResult>;
  ensureIconSource(): Promise<string>;
  resolve<K extends keyof CapabilityConfigMap>(
    name: K,
    config?: CapabilityConfigMap[K]
  ): ResolvedCapability;
  isKnownCapability(name: string): name is keyof CapabilityConfigMap;
  getRegistryRows(): ReadonlyArray<RegistryRow>;
  getRequiredFiles(opts: { target: MobileTarget }): readonly string[];
};
