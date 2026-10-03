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

/**
 * Result of the idempotent mobile patch pass: Android release signing and the main
 * activity's manifest attributes, the iOS Xcode build settings, and the runner command
 * on both platforms. A file several patches touched is listed once.
 */
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
 * A row is backed by a real Tauri plugin (crate + npm package + Rust init), by a core
 * Tauri cargo feature (tray), or by core permissions alone (back), so every plugin-only
 * field is optional and `cargoFeatures` is always present.
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

/**
 * A tauri.conf.json `plugins.<name>` contribution — the union of the real v1 shapes. The
 * empty member is the "this plugin takes no config" case: it is never written to
 * tauri.conf.json, because such a plugin deserializes `unit` and a `{}` map there aborts
 * the app at startup.
 */
export type TauriConfFragment = Record<string, never> | DeepLinkConf;

/**
 * One Info.plist value: a `<string>`, a `<true/>`/`<false/>`, or an `<array>` of strings.
 *
 * @example
 * ```ts
 * const fullScreen: PlistValue = true; // <true/>
 * const portrait: PlistValue = ["UIInterfaceOrientationPortrait"];
 * // <array><string>UIInterfaceOrientationPortrait</string></array>
 * ```
 */
export type PlistValue = string | boolean | readonly string[];

/**
 * An Info.ios.plist sidecar entry (src-tauri root, outside gen/), which Tauri merges into
 * the app's Info.plist on every iOS build. No registry row carries one today; the
 * orientation lock does.
 */
export type PlistEntry = { key: string; value: PlistValue };

/**
 * An AndroidManifest need. `activity-attribute` sets one attribute on the main
 * `<activity>`, or removes it when `value` is `undefined`; the orientation lock is one.
 * `child` is the seam for a child element and the patch pass does not apply it. No
 * registry row carries either kind: official plugins self-merge via build.rs.
 */
export type ManifestEntry =
  | { kind: "child"; parentTag: string; xml: string }
  | { kind: "activity-attribute"; name: `android:${string}`; value: string | undefined };

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
  /**
   * Runs the idempotent mobile post-init patch pass. Android gets its release signing and
   * the main activity's manifest attributes (the orientation lock among them); iOS gets
   * the Xcode entitlements-modification setting; both get the Xcode/Android-Studio
   * runner-command rewrite when a `runner` is supplied. The build plugin calls it after
   * the mobile init pass, with the runner from `tauri.getRunner()`.
   *
   * @param opts - The patch options.
   * @param opts.target - The mobile platform to patch.
   * @param opts.runner - The absolute Node/`tauri.js` pair from `tauri.getRunner()`.
   * @returns The paths patched vs. left unchanged.
   * @example
   * ```ts
   * // app.orientation is "portrait", projectDir is the default, the lock is not written yet
   * await app.project.patchMobile({ target: "android" });
   * // { patched: [".moku/tauri/src-tauri/gen/android/app/src/main/AndroidManifest.xml"],
   * //   unchanged: [".moku/tauri/src-tauri/gen/android/app/build.gradle.kts"] }
   * ```
   */
  patchMobile(opts: PatchMobileOptions): Promise<PatchResult>;
  clean(opts?: { target?: Target | undefined }): Promise<CleanResult>;
  clearMobileBuildOutput(opts: { target: MobileTarget }): Promise<CleanResult>;
  resolveDerivedPath(target: string): string;
  ensureIconSource(): Promise<string>;
  resolve<K extends keyof CapabilityConfigMap>(
    name: K,
    config?: CapabilityConfigMap[K]
  ): ResolvedCapability;
  isKnownCapability(name: string): name is keyof CapabilityConfigMap;
  getRegistryRows(): ReadonlyArray<RegistryRow>;
  getRequiredFiles(opts: { target: MobileTarget }): readonly string[];
};
