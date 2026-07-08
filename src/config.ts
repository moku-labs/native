/**
 * @file Framework configuration — Config + Events types, shared constants, core plugin registration.
 */
import { envPlugin, logPlugin } from "@moku-labs/common";
import { createCoreConfig } from "@moku-labs/core";

/** The five packaging targets (D1 — all five in v1). */
export const TARGETS = ["macos", "windows", "linux", "ios", "android"] as const;

/** A native packaging target. */
export type Target = (typeof TARGETS)[number];

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

/** Signing configuration — env-var REFERENCES and config-safe identifiers only, never raw secrets. */
export type SigningConfig = {
  android?: { keystorePath?: string; keystorePasswordEnv?: string; keyAlias?: string };
  windows?: { certificateThumbprint?: string };
};

/**
 * Global configuration shape for the framework. Read by every plugin via `ctx.global`.
 * Required-with-defaults fields keep the complete-C default literal valid under exactOptionalPropertyTypes.
 */
export type Config = {
  /** App identity — project.onInit validates name/identifier are non-empty (reverse-DNS identifier). */
  app: { name: string; identifier: string; version?: string };
  /** Web build/dev wiring codegenned into tauri.conf.json (S3). cwd for monorepo layouts (S3-refined). */
  web: { build: string; dev: { command: string; url: string }; dist: string; cwd?: string };
  /** Composed `@moku-labs/system` plugins — the kernel-guaranteed name-only contract (spec/03 §1). */
  system: ReadonlyArray<{ name: string }>;
  /** Per-capability packaging parameters. */
  capabilities: Partial<CapabilityConfigMap>;
  /** Targets this app ships (D1 default: all five). */
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

const defaultConfig: Config = {
  app: { name: "", identifier: "" },
  web: {
    build: "bun run build",
    dev: { command: "bun run dev", url: "http://localhost:5173" },
    dist: "dist"
  },
  system: [],
  capabilities: {},
  targets: TARGETS,
  projectDir: ".moku/tauri",
  outDir: "dist-native",
  signing: {}
};

export const coreConfig = createCoreConfig<Config, Events, [typeof logPlugin, typeof envPlugin]>(
  "native",
  {
    config: defaultConfig,
    plugins: [logPlugin, envPlugin] // core plugins → ctx.log + ctx.env on every ctx
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
