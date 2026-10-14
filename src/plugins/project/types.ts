/**
 * @file project plugin — type definitions.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type {
  BuildProfile,
  CapabilityConfigMap,
  Config,
  MobileTarget,
  Target,
  TauriRunner
} from "../../config";
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

/**
 * Options for one mobile patch pass. The runner patch is skipped when `runner` is absent;
 * an absent `profile` is the store profile.
 */
export type PatchMobileOptions = {
  target: MobileTarget;
  runner?: TauriRunner | undefined;
  profile?: BuildProfile | undefined;
};

/**
 * The build profile one Android patch pass applies, with what that profile needs: the
 * debug profile names the app `"<name> (debug)"` and signs with the debug keystore the
 * caller resolved from `ctx.env`. `log` receives the warning about a network security
 * config this plugin did not write.
 *
 * @example
 * ```ts
 * const profile: AndroidProfile = { profile: "debug", appName: "Demo", debugKeystore: "/home/me/.android/debug.keystore" };
 * ```
 */
export type AndroidProfile =
  | { readonly profile: "store"; readonly log?: Pick<LogApi, "warn"> | undefined }
  | {
      readonly profile: "debug";
      readonly appName: string;
      readonly debugKeystore: string;
      readonly log?: Pick<LogApi, "warn"> | undefined;
    };

/**
 * What a scan of the built page found: whether the editor agent ships in it, and the
 * first `.js` file (relative to `web.dist`, POSIX separators) that carries it.
 *
 * @example
 * ```ts
 * const found: PageAgentResult = { agent: true, file: "page/main-4f2a.js" };
 * ```
 */
export type PageAgentResult = { agent: boolean; file?: string };

/** Result of a clean pass. */
export type CleanResult = { removed: readonly string[] };

/**
 * One capability registry row — packaging metadata with per-row research confidence.
 * A row is backed by a real Tauri plugin (crate + npm package + Rust init), by a core
 * Tauri cargo feature (tray), by core permissions alone (back), or by a plugin crate this
 * plugin generates itself (shell, `localCrate`), so every plugin-only field is optional and
 * `cargoFeatures` is always present. A row has `crate` + `crateRange` or `localCrate`,
 * never both.
 */
export type RegistryRow = {
  name: keyof CapabilityConfigMap;
  npmPackage?: `@tauri-apps/plugin-${string}`;
  crate?: `tauri-plugin-${string}`;
  crateRange?: string;
  /**
   * A generated plugin crate, linked by path: its package name, and its directory
   * relative to `projectDir` (POSIX).
   */
  localCrate?: { readonly name: "tauri-plugin-moku-shell"; readonly directory: string };
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
 * `application-attribute` does the same on the `<application>` start tag; the debug
 * profile's network security config is one. `child` is the seam for a child element and
 * the patch pass does not apply it. No registry row carries any kind: official plugins
 * self-merge via build.rs.
 */
export type ManifestEntry =
  | { kind: "child"; parentTag: string; xml: string }
  | { kind: "activity-attribute"; name: `android:${string}`; value: string | undefined }
  | { kind: "application-attribute"; name: `android:${string}`; value: string | undefined };

/** A capability resolved against consumer config. */
export type ResolvedCapability = RegistryRow & {
  conf: TauriConfFragment;
  sidecarPlist: readonly PlistEntry[];
  manifest: readonly ManifestEntry[];
};

/**
 * Domain context for the project plugin's API factory: core's `PluginCtx` (this plugin
 * declares neither config nor state nor events — D-005, it reads global config only) plus
 * the fields core composes in per framework: `global`, the `log` core API (MC2) and the
 * `env` core API (MC3), which resolves the debug keystore's home directory.
 */
export type ProjectContext = PluginCtx<Record<string, never>, Record<string, never>> & {
  readonly global: Readonly<Config>;
  readonly log: LogApi;
  readonly env: EnvApi;
};

/** Public API of the project plugin. */
export type Api = {
  /**
   * Writes or refreshes every pure artifact of one target into `projectDir`, through the
   * write-if-changed writer. When the `shell` capability is composed for the target (named
   * in `config.system`, or implied by the debug profile on android), the
   * `tauri-plugin-moku-shell` crate is generated under `plugins/moku-shell/` too, with the
   * profile baked into its page script. Without the shell, the output is the same for both
   * profiles.
   *
   * @param opts - The generate options.
   * @param opts.target - The packaging target to generate for.
   * @param opts.profile - The build profile; `"store"` when omitted.
   * @returns Which paths were written, left unchanged, or skipped.
   * @example
   * ```ts
   * // A debug build of an Android app: the shell crate is generated even without a system entry.
   * await app.project.generate({ target: "android", profile: "debug" });
   * // { written: [".moku/tauri/src-tauri/tauri.conf.json", …, ".moku/tauri/plugins/moku-shell/src/page.js", …],
   * //   unchanged: [], skipped: [] }
   * ```
   */
  generate(opts: { target: Target; profile?: BuildProfile | undefined }): Promise<GenerateResult>;
  getBundleLayout(opts: { target: Target }): BundleLayout;
  getCompleteness(opts: { target: Target }): CompletenessResult;
  /**
   * Runs the idempotent mobile post-init patch pass. Android gets its build-profile
   * patches (debug: the `.debug` id suffix, the `"<name> (debug)"` label, a cleartext
   * network security config; store: all three reverted to the bytes before), its release
   * signing (the debug keystore under `HOME` ?? `USERPROFILE` in the debug profile), the
   * main activity's manifest attributes (the orientation lock among them) and the status
   * bar style in MainActivity.kt (light icons on a dark `app.backgroundColor`, dark icons
   * on a light one); iOS gets the Xcode entitlements-modification setting; both get the
   * Xcode/Android-Studio runner-command rewrite when a `runner` is supplied. The build
   * plugin calls it after the mobile init pass, with the runner from `tauri.getRunner()`.
   *
   * @param opts - The patch options.
   * @param opts.target - The mobile platform to patch.
   * @param opts.runner - The absolute Node/`tauri.js` pair from `tauri.getRunner()`.
   * @param opts.profile - The build profile; `"store"` when omitted.
   * @returns The paths patched vs. left unchanged.
   * @throws {Error} `[native]` in the debug profile when the debug keystore is missing,
   *   with the `keytool` command that creates it.
   * @example
   * ```ts
   * // app.orientation is "portrait", app.backgroundColor is "#10161d", app.identifier is
   * // "com.acme.demo", projectDir is the default, and neither is written yet
   * await app.project.patchMobile({ target: "android" });
   * // { patched: [".moku/tauri/src-tauri/gen/android/app/src/main/AndroidManifest.xml",
   * //             ".moku/tauri/src-tauri/gen/android/app/src/main/java/com/acme/demo/MainActivity.kt"],
   * //   unchanged: [".moku/tauri/src-tauri/gen/android/app/build.gradle.kts"] }
   * ```
   */
  patchMobile(opts: PatchMobileOptions): Promise<PatchResult>;
  /**
   * Wraps the Android adaptive icon foreground (`ic_launcher.xml` and the round icon) in an
   * `<inset>` of `app.adaptiveIconInset` percent per side, or restores the plain foreground
   * when the inset is unset. `tauri icon` rewrites these files, so the build plugin calls
   * this after its icons phase, on every build. Idempotent; iOS and a tree without the
   * adaptive icon directory get an empty result.
   *
   * @param opts - The patch options.
   * @param opts.target - The mobile platform whose icons to patch.
   * @returns The icon files patched vs. left unchanged.
   * @example
   * ```ts
   * // app.adaptiveIconInset is 19.44 and `tauri icon` just rewrote the launcher icons.
   * await app.project.patchMobileIcons({ target: "android" });
   * // { patched: [".moku/tauri/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
   * //             ".moku/tauri/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml"],
   * //   unchanged: [] }
   * ```
   */
  patchMobileIcons(opts: { target: MobileTarget }): Promise<PatchResult>;
  /**
   * Scans every `.js` file of the built page (`<web.cwd ?? .>/<web.dist>`) for the editor
   * agent's marker strings — `"/__editor/hello"` and `"[moku-editor]"`, the two the engine's
   * own release refusal uses. Source maps, HTML and symlinks out of the dist are never read.
   * A missing dist is no agent.
   *
   * @returns `{ agent: true, file }` for the first file that carries the agent (relative to
   *   the dist), `{ agent: false }` otherwise.
   * @example
   * ```ts
   * // The build plugin refuses a store build whose page still carries the editor agent.
   * const page = await ctx.require(projectPlugin).detectPageAgent();
   * // { agent: true, file: "page/main-4f2a.js" }
   * ```
   */
  detectPageAgent(): Promise<PageAgentResult>;
  /**
   * Checks, after the compile phase, that the shell plugin is linked into the generated
   * Gradle project: when `shell` is composed for the target and profile,
   * `gen/android/tauri.settings.gradle` must name `moku-shell`. A tree initialised before
   * the shell was added fails here instead of failing every `__MOKU_NATIVE__` call at
   * runtime. A target or profile without the shell is a no-op.
   *
   * @param opts - The check options.
   * @param opts.target - The mobile platform that was compiled.
   * @param opts.profile - The build profile; `"store"` when omitted.
   * @throws {Error} `[native] the shell plugin is not linked into gen/android …` with the
   *   clean-and-rebuild fix.
   * @example
   * ```ts
   * // A debug android build composes the shell, so a stale tree fails before collect.
   * await app.project.checkShellLinked({ target: "android", profile: "debug" });
   * // rejects: [native] the shell plugin is not linked into gen/android (tree initialised …)
   * ```
   */
  checkShellLinked(opts: {
    target: MobileTarget;
    profile?: BuildProfile | undefined;
  }): Promise<void>;
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
