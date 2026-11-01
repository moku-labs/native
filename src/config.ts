/**
 * @file Framework configuration — Config + Events types, shared constants, core plugin registration.
 */
import { envPlugin, logPlugin, workerSafeProcessEnv } from "@moku-labs/common";
import { createCoreConfig } from "@moku-labs/core";

/** The five packaging targets shipped in v1. */
export const TARGETS = ["macos", "windows", "linux", "ios", "android"] as const;

/** A native packaging target. */
export type Target = (typeof TARGETS)[number];

/**
 * The two targets that own a `src-tauri/gen/<platform>` tree — the init/completeness/patch
 * story is theirs alone, so every mobile-only signature takes this instead of `Target`.
 */
export type MobileTarget = Extract<Target, "ios" | "android">;

/**
 * The absolute `node` + `tauri.js` pair every Tauri invocation is spawned with. The `tauri`
 * plugin resolves it, and `project` writes the SAME pair into the generated Xcode/Gradle
 * build phases, where Tauri's own generator emits a bare `node tauri` that does not exist.
 */
export type TauriRunner = { nodePath: string; tauriJsPath: string };

/**
 * Which artifact flavour a mobile build produces. Shared verbatim by `tauri.build`,
 * `build.run`/`build.runAll`, `cli.build` and the collect phase, so one flag set travels
 * the whole pipeline instead of being re-declared per layer. A target that does not use a
 * flag ignores it rather than failing.
 */
export type BuildFlavor = {
  /** iOS: build the host's simulator slice instead of a signed device archive. */
  simulator?: boolean | undefined;
  /** Android: emit a store bundle (`.aab`) instead of the default installable `.apk`. */
  aab?: boolean | undefined;
  /**
   * Build the debug profile instead of the store one: a still-optimized build that installs
   * next to the store app (`.debug` id, "(debug)" name), is signed with the debug keystore,
   * forwards the page console and allows cleartext. Unset means the store profile.
   *
   * @example
   * ```ts
   * await app.build.run({ target: "android", debug: true });
   * ```
   */
  debug?: boolean | undefined;
  /**
   * Build the dev profile instead of the store one: the store build a tester installs, with
   * the same signing, `.aab`, `exportMethod` and delivery, whose page may carry the editor
   * agent. The app config names the separate app (id, name, icon, `projectDir`, `outDir`);
   * native renames nothing. Combining it with `debug` is an error.
   *
   * @example
   * ```ts
   * await app.build.run({ target: "android", aab: true, dev: true });
   * ```
   */
  dev?: boolean | undefined;
};

/**
 * Which profile a build is made in. `"store"` is the shippable build; `"debug"` is the
 * on-device test build of {@link BuildFlavor.debug}; `"dev"` is the store-signed test build
 * of {@link BuildFlavor.dev}. The page sees `"store"` and `"dev"` as `"release"`.
 *
 * @example
 * ```ts
 * const profile: BuildProfile = flavor.dev ? "dev" : "store";
 * ```
 */
export type BuildProfile = "store" | "debug" | "dev";

/** Host platform → the one desktop target that host can package locally. */
const HOST_TARGET: Partial<Record<NodeJS.Platform, Target>> = {
  darwin: "macos",
  win32: "windows",
  linux: "linux"
};

/**
 * Resolves the packaging targets a host can build with no extra opt-in — the default
 * `config.targets`. Exactly one desktop target per host (`darwin` → `macos`,
 * `win32` → `windows`, `linux` → `linux`), and an empty list for any other host.
 *
 * Mobile is never inferred: `ios`/`android` need an SDK the host may not have, so a
 * consumer asks for them explicitly via `config.targets`.
 *
 * @param platform - The host platform id (`process.platform`).
 * @returns The targets that host packages by default — frozen-safe, never mobile.
 * @example
 * ```ts
 * createApp({ config: { targets: [...hostTargets(process.platform), "ios"] } });
 * ```
 */
export function hostTargets(platform: NodeJS.Platform): readonly Target[] {
  const target = HOST_TARGET[platform];
  return target ? [target] : [];
}

/** Pipeline phases in execution order — drives NativePhase and progress rendering (mirrors web's PHASE_ORDER). */
export const PHASE_ORDER = [
  "scaffold",
  "codegen",
  "icons",
  "compile",
  "bundle",
  "collect"
] as const;

/** A build pipeline phase. */
export type NativePhase = (typeof PHASE_ORDER)[number];

/**
 * Per-capability packaging parameters — ONE map drives both `Config["capabilities"]`
 * and project's `resolve<K extends keyof CapabilityConfigMap>` (refined; spec/09 §3/§5 technique).
 * deep-link is custom-scheme-only in v1 (D-011); the `mode` discriminant keeps `"universal"` additive later.
 */
export type CapabilityConfigMap = {
  store: Record<string, never>;
  notification: Record<string, never>;
  "clipboard-manager": Record<string, never>;
  tray: Record<string, never>;
  "deep-link": { mode: "scheme"; scheme: string };
  back: Record<string, never>;
  haptics: Record<string, never>;
  /**
   * The page bridge `globalThis.__MOKU_NATIVE__` (Android): display rate, thermal state,
   * safe-area insets, device info. Composed like every capability, by naming it in
   * `config.system`; this entry only carries its (empty) parameters and composes nothing alone.
   *
   * @example
   * ```ts
   * createApp({ config: { system: [{ name: "shell" }], capabilities: { shell: {} } } });
   * ```
   */
  shell: Record<string, never>;
};

/**
 * Which way up a mobile app runs. Build time only: it picks the iOS `Info.plist`
 * orientation keys and the Android main activity's `android:screenOrientation`, and
 * nothing locks the screen at runtime. `"any"` keeps the Tauri template's default.
 *
 * @example
 * ```ts
 * createApp({ config: { app: { name: "Demo", identifier: "com.acme.demo", orientation: "portrait" } } });
 * ```
 */
export type Orientation = "portrait" | "landscape" | "any";

/**
 * One Info.plist value: a `<string>`, a `<true/>`/`<false/>`, an `<array>` or a `<dict>`,
 * nested as deep as the key needs.
 *
 * @example
 * ```ts
 * const encryption: PlistValue = false; // ITSAppUsesNonExemptEncryption
 * const transport: PlistValue = { NSAllowsLocalNetworking: true }; // NSAppTransportSecurity
 * ```
 */
export type PlistValue =
  | string
  | boolean
  | readonly PlistValue[]
  | { readonly [key: string]: PlistValue };

/** How `tauri ios build` exports the signed archive (`--export-method`). */
export type AppleExportMethod = "app-store-connect" | "release-testing" | "debugging";

/**
 * Apple signing identifiers for macOS and iOS builds — identifiers only, never secrets.
 * Credentials stay in the environment and Tauri reads them itself: `APPLE_ID`,
 * `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_KEY`, `APPLE_API_ISSUER`,
 * `APPLE_API_KEY_PATH`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`.
 */
export type AppleSigning = {
  /** Apple Developer team id → `bundle.iOS.developmentTeam`. */
  teamId?: string;
  /** Codesign identity → `bundle.macOS.signingIdentity`; `"-"` means ad-hoc. */
  signingIdentity?: string;
  /** Multi-team notarization provider → `bundle.macOS.providerShortName`. */
  providerShortName?: string;
  /** Consumer entitlements plist, relative to cwd → `bundle.macOS.entitlements`. */
  entitlements?: string;
  /** Generate a sandbox entitlements file for the App Store when `entitlements` is unset. */
  appStore?: boolean;
  /** Archive export method passed to `tauri ios build`. */
  exportMethod?: AppleExportMethod;
  /** Minimum macOS version → `bundle.macOS.minimumSystemVersion`. */
  macosMinimumSystemVersion?: string;
  /** Minimum iOS version → `bundle.iOS.minimumSystemVersion`; `"15.0"` when unset (Xcode 27 rejects Tauri's 14.0). */
  iosMinimumSystemVersion?: string;
};

/** Signing configuration — env-var REFERENCES and config-safe identifiers only, never raw secrets. */
export type SigningConfig = {
  apple?: AppleSigning;
  android?: {
    keystorePath?: string;
    keystorePasswordEnv?: string;
    /** Key password env-var name; falls back to `keystorePasswordEnv` when unset. */
    keyPasswordEnv?: string;
    keyAlias?: string;
  };
  windows?: { certificateThumbprint?: string };
};

/**
 * Global configuration shape for the framework. Read by every plugin via `ctx.global`.
 * Required-with-defaults fields keep the complete-C default literal valid under exactOptionalPropertyTypes.
 */
export type Config = {
  /**
   * App identity, store metadata and presentation — project.onInit validates
   * name/identifier are non-empty (reverse-DNS identifier). `icon` is a 1024x1024 PNG
   * relative to cwd (a placeholder is generated when unset); `category` maps to
   * `bundle.category`; `buildNumber` maps to the iOS/macOS `bundleVersion` and, a whole
   * number from 1 to 2 100 000 000, to the Android `versionCode`; `orientation` locks the mobile screen at build time; `backgroundColor` paints the
   * native window behind the page.
   */
  app: {
    name: string;
    identifier: string;
    version?: string;
    icon?: string;
    category?: string;
    buildNumber?: string;
    /**
     * Build-time mobile orientation lock → the iOS `Info.plist` keys and the Android
     * main activity's `android:screenOrientation`. There is no runtime lock. Unset
     * behaves as `"any"`.
     */
    orientation?: Orientation;
    /**
     * Hex window colour (`"#10161d"`, or `"#10161dff"` with alpha) →
     * `app.windows[0].backgroundColor`. Shows during launch and behind any gap the page
     * does not cover. On Android it also paints the activity window and the icon splash,
     * so no dark frame shows before the page's first paint, and the status bar icons follow
     * it: light icons on a dark colour, dark icons on a light one. Unset leaves the
     * platform default (white in light mode).
     */
    backgroundColor?: string;
    /**
     * Android adaptive icon inset, in percent of the 108 dp canvas per side (`0 < n ≤ 30`).
     * Wraps the launcher foreground in an `<inset>` so full-bleed art survives the mask.
     * Unset leaves the icon untouched. `19.44` keeps the art inside the 66 dp safe zone.
     *
     * @example
     * ```ts
     * createApp({ config: { app: { name: "Demo", identifier: "com.acme.demo", adaptiveIconInset: 19.44 } } });
     * ```
     */
    adaptiveIconInset?: number;
    /**
     * iOS: the app turns the idle timer off at launch, so the screen does not dim while it
     * runs. Android keeps it on from the page. Unset leaves the idle timer on.
     *
     * @example
     * ```ts
     * createApp({ config: { app: { name: "Demo", identifier: "com.acme.demo", keepScreenOn: true } } });
     * ```
     */
    keepScreenOn?: boolean;
  };
  /** Web build/dev wiring codegenned into tauri.conf.json. cwd for monorepo layouts. */
  web: { build: string; devCommand: string; devUrl: string; dist: string; cwd?: string };
  /** Composed `@moku-labs/system` plugins — the kernel-guaranteed name-only contract (spec/03 §1). */
  system: ReadonlyArray<{ name: string }>;
  /** Per-capability packaging parameters. */
  capabilities: Partial<CapabilityConfigMap>;
  /** Targets this app ships (default: the host's own desktop target — see {@link hostTargets}). */
  targets: readonly Target[];
  /** Generated Tauri project root (contains src-tauri/). Gitignored build output. */
  projectDir: string;
  /** Installer delivery root. */
  outDir: string;
  /** Signing env-var references. */
  signing: SigningConfig;
  /**
   * What an iOS app adds to its bundle. `infoPlist` merges into `Info.plist`, where
   * `app.orientation` wins a shared key; `privacyManifest` is the absolute path of the file
   * the bundle carries as `PrivacyInfo.xcprivacy`. Unset, a manifest an earlier build left
   * in the generated tree is removed.
   *
   * @example
   * ```ts
   * createApp({ config: { ios: { infoPlist: { ITSAppUsesNonExemptEncryption: false } } } });
   * ```
   */
  ios?: {
    infoPlist?: Readonly<Record<string, PlistValue>>;
    privacyManifest?: string;
  };
};

/** native:phase payload — one flat event, target as a field (context decision). */
export type NativePhaseEvent = {
  target: Target;
  phase: NativePhase;
  status: "start" | "progress" | "done" | "error";
  durationMs?: number;
  detail?: string;
};

/** native:complete payload — where the shippable artifacts landed. */
export type NativeCompleteEvent = {
  target: Target;
  outPath: string;
  artifacts: readonly string[];
  durationMs: number;
  /** The profile the artifacts were built in — the CLI marks a debug delivery. */
  profile: BuildProfile;
};

/**
 * Framework-level events (spec/07 §6 `framework-domain:*`) — emitted by build, hookable by all plugins.
 */
export type Events = {
  "native:phase": NativePhaseEvent;
  "native:complete": NativeCompleteEvent;
};

const defaultConfig: Config = {
  app: { name: "", identifier: "" },
  web: {
    build: "bun run build",
    devCommand: "bun run dev",
    devUrl: "http://localhost:5173",
    dist: "dist"
  },
  system: [],
  capabilities: {},
  targets: hostTargets(process.platform),
  projectDir: ".moku/tauri",
  outDir: "dist-native",
  signing: {}
};

/**
 * The Layer-1 config of `@moku-labs/native`: the global {@link Config} defaults, the
 * framework {@link Events} (`native:phase`, `native:complete`) and the `log`/`env` core
 * plugins, so every plugin context carries `ctx.log` and `ctx.env`. The `env` core plugin is
 * seeded with the process-env provider. `src/index.ts` composes it with the five framework
 * plugins.
 *
 * @example
 * ```ts
 * // src/index.ts — the framework is this config plus its plugins, in dependency order.
 * const framework = createCore(coreConfig, {
 *   plugins: [projectPlugin, tauriPlugin, buildPlugin, doctorPlugin, cliPlugin]
 * });
 * ```
 */
export const coreConfig = createCoreConfig<Config, Events, [typeof logPlugin, typeof envPlugin]>(
  "native",
  {
    config: defaultConfig,
    plugins: [logPlugin, envPlugin], // core plugins → ctx.log + ctx.env on every ctx
    pluginConfigs: {
      // Core-plugin default (levels 1–2 of the 4-level core cascade, spec/03 §5).
      // The `env` core plugin ships with ZERO providers, which left `ctx.env.get("PATH")`
      // undefined — and with it the tauri plugin's PATH-walk node resolution. Seeded here,
      // exactly as `@moku-labs/worker` seeds it. A consumer CAN still override it from
      // `createApp({ pluginConfigs: { env } })` — the key is just untyped there — and an
      // override REPLACES this list rather than extending it.
      env: { providers: [workerSafeProcessEnv()] }
    }
  }
);

/**
 * Creates a plugin bound to this framework's Config/Events chain.
 *
 * @param name - Unique plugin id; becomes the plugin's key on the app.
 * @param spec - Plugin spec (config, state, api, hooks, lifecycle); every type infers from it.
 * @returns A typed plugin instance for the `createCore` or `createApp` plugins array.
 * @example
 * ```ts
 * export const xxxPlugin = createPlugin("xxx", { api: createXxxApi });
 * ```
 */
export const createPlugin = coreConfig.createPlugin;

/**
 * Creates the framework core from this config (Layer 2 step 2).
 *
 * @param config - This file's {@link coreConfig}.
 * @param options - The framework's default plugins (`plugins`), plus optional `pluginConfigs`
 *   and lifecycle callbacks.
 * @returns The framework factory carrying `createApp` and `createPlugin`.
 * @example
 * ```ts
 * const framework = createCore(coreConfig, { plugins: [...] });
 * ```
 */
export const createCore = coreConfig.createCore;
