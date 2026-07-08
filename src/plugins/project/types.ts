/**
 * @file project plugin — type definitions.
 */
import type { CapabilityConfigMap, Target } from "../../config";

/** Result of a write-if-changed generation pass. */
export type GenerateResult = { written: string[]; unchanged: string[]; skipped: string[] };

/** Mobile gen/-tree gate — completeness (required-file set), not existence (S4 refinement). */
export type CompletenessResult =
  | { status: "not-applicable" }
  | { status: "not-initialized" }
  | { status: "incomplete"; missing: readonly string[] }
  | { status: "complete" };

/** Result of the idempotent mobile patch pass (v1: Android signing only). */
export type PatchResult = { patched: string[]; unchanged: string[] };

/** Result of a clean pass. */
export type CleanResult = { removed: readonly string[] };

/** One capability registry row — packaging metadata with per-row research confidence. */
export type RegistryRow = {
  name: keyof CapabilityConfigMap;
  npmPackage: `@tauri-apps/plugin-${string}`;
  crate: `tauri-plugin-${string}`;
  crateRange: string;
  npmRange: string;
  rustInit: string;
  permissions: readonly string[];
  platforms: readonly Target[];
  confidence: "high" | "medium" | "low";
};

/** A tauri.conf.json contribution fragment (plugins section + bundle metadata). */
export type TauriConfFragment = Record<string, unknown>;

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

/** Public API of the project plugin. */
export type Api = {
  generate(opts: { target: Target }): Promise<GenerateResult>;
  completeness(opts: { target: Target }): CompletenessResult;
  patchMobile(opts: { target: "ios" | "android" }): Promise<PatchResult>;
  clean(opts?: { target?: Target }): Promise<CleanResult>;
  resolve<K extends keyof CapabilityConfigMap>(
    name: K,
    config?: CapabilityConfigMap[K]
  ): ResolvedCapability;
  isKnownCapability(name: string): name is keyof CapabilityConfigMap;
  registryRows(): ReadonlyArray<RegistryRow>;
  requiredFiles(platform: "ios" | "android"): readonly string[];
};
