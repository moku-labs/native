/**
 * @file Framework configuration — Config + Events types, shared constants, core plugin registration.
 */
import { envPlugin, logPlugin, workerSafeProcessEnv } from "@moku-labs/common";
import { createCoreConfig } from "@moku-labs/core";

/** The five packaging targets (D1 — all five in v1). */
export const TARGETS = ["macos", "windows", "linux", "ios", "android"] as const;

/** A native packaging target. */
export type Target = (typeof TARGETS)[number];

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
 * and project's `resolve<K extends keyof CapabilityConfigMap>` (S2-refined; spec/09 §3/§5 technique).
 * deep-link is custom-scheme-only in v1 (D-011); the `mode` discriminant keeps `"universal"` additive later.
 */
export type CapabilityConfigMap = {
  store: Record<string, never>;
  notification: Record<string, never>;
  "clipboard-manager": Record<string, never>;
  tray: Record<string, never>;
  "deep-link": { mode: "scheme"; scheme: string };
};

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
  /** Minimum iOS version → `bundle.iOS.minimumSystemVersion`. */
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
   * App identity and store metadata — project.onInit validates name/identifier are
   * non-empty (reverse-DNS identifier). `icon` is a 1024x1024 PNG relative to cwd
   * (a placeholder is generated when unset); `category` maps to `bundle.category`;
   * `buildNumber` maps to the iOS/macOS `bundleVersion`.
   */
  app: {
    name: string;
    identifier: string;
    version?: string;
    icon?: string;
    category?: string;
    buildNumber?: string;
  };
  /** Web build/dev wiring codegenned into tauri.conf.json (S3). cwd for monorepo layouts (S3-refined). */
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
};

/**
 * Framework-level events (spec/07 §6 `framework-domain:*`) — emitted by build, hookable by all plugins.
 */
export type Events = {
  "native:phase": NativePhaseEvent;
  "native:complete": NativeCompleteEvent;
};

/**
 * Structural mirror of `@moku-labs/core`'s unexported `PluginLike` — same field shape
 * (`name`/`spec`/`_phantom`), so a real plugin instance (e.g. `projectPlugin`) satisfies
 * it without importing a core-internal type. `PluginCtx`'s own JSDoc anticipates this:
 * "for advanced composition (e.g. adding require), use EmitFn<E> directly" — this is the
 * `require`-side equivalent, re-derived once HERE and shared by every plugin that needs
 * it (build, doctor, cli), since core intentionally exports only `PluginCtx`/`EmitFn`
 * for domain composition (moku-testing mock-context.md).
 */
export type PluginLike = {
  readonly name: string;
  readonly spec: unknown;
  readonly _phantom: {
    readonly config: unknown;
    readonly state: unknown;
    readonly api: unknown;
    readonly events?: Record<string, unknown>;
  };
};

/**
 * Extracts a plugin-like value's API type from its phantom `api` slot — what
 * `ctx.require(plugin)` resolves to.
 */
export type PluginApiOf<P extends PluginLike> = P extends {
  readonly _phantom: { readonly api: infer A };
}
  ? A
  : never;

/**
 * The `ctx.require` signature a structural domain context declares when a plugin
 * resolves its dependencies' APIs (build, doctor, cli).
 */
export type RequireFn = <P extends PluginLike>(plugin: P) => PluginApiOf<P>;

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

export const coreConfig = createCoreConfig<Config, Events, [typeof logPlugin, typeof envPlugin]>(
  "native",
  {
    config: defaultConfig,
    plugins: [logPlugin, envPlugin], // core plugins → ctx.log + ctx.env on every ctx
    pluginConfigs: {
      // Core-plugin default (levels 1–2 of the 4-level core cascade, spec/03 §5).
      // The `env` core plugin ships with ZERO providers, which left `ctx.env.get("PATH")`
      // undefined — and with it the tauri plugin's PATH-walk node resolution. Seeded here
      // (core-plugin config is sealed from createApp — spec/05 §1b), exactly as
      // `@moku-labs/worker` seeds it. Overriding `providers` REPLACES this list.
      env: { providers: [workerSafeProcessEnv()] }
    }
  }
);

/**
 * Creates a plugin bound to this framework's Config/Events chain.
 *
 * @example
 * ```ts
 * export const xxxPlugin = createPlugin("xxx", { api: createXxxApi });
 * ```
 */
export const createPlugin = coreConfig.createPlugin;

/**
 * Creates the framework core from this config (Layer 2 step 2).
 *
 * @example
 * ```ts
 * const framework = createCore(coreConfig, { plugins: [...] });
 * ```
 */
export const createCore = coreConfig.createCore;
