// biome-ignore-all assist/source/organizeImports: grouped export sections (Framework API → Plugins → Helpers → Types) are house style (D-010)
/**
 * @file `@moku-labs/native` — node-only native packager framework for Moku (Tauri 2).
 *
 * The package root exports the bound {@link createApp} factory (the Layer-3 entry point),
 * {@link createPlugin} for consumer plugins, every plugin instance, the `hostTargets`
 * helper, the `TauriError` class, and the framework types. Composing an app generates a
 * gitignored Tauri project, codegens the permission surface (`capabilities`, `Info.plist`,
 * `AndroidManifest.xml`) from the composed `@moku-labs/system` plugins, and runs
 * `tauri build`.
 *
 * `createApp(options?)` boots a fully-typed, synchronous app. The framework defaults —
 * core `[logPlugin, envPlugin]` plus `[projectPlugin, tauriPlugin, buildPlugin,
 * doctorPlugin, cliPlugin]` — are wired first, then `options` are shallow-merged on top:
 *
 * - `config` — `Partial<Config>`; the global config table below. Shallow merge, so a
 *   nested object (`app`, `web`, `signing`) is REPLACED whole, never deep-merged.
 * - `pluginConfigs` — per-plugin overrides keyed by plugin name; the second table below.
 * - `plugins` — extra consumer `PluginInstance[]` appended to the defaults; default `[]`.
 * - `onReady` / `onError` / `onStart` / `onStop` — optional lifecycle callbacks.
 *
 * Global config (`config`) — every default lives in `src/config.ts`:
 *
 * | Field | Type | Default |
 * |---|---|---|
 * | `app` | `{ name; identifier; version?; icon?; category?; buildNumber? }` | `{ name: "", identifier: "" }` — both validated non-empty at composition |
 * | `web` | `{ build; devCommand; devUrl; dist; cwd? }` | `"bun run build"`, `"bun run dev"`, `"http://localhost:5173"`, `"dist"` |
 * | `system` | `ReadonlyArray<{ name: string }>` | `[]` — the composed `@moku-labs/system` plugins |
 * | `capabilities` | `Partial<CapabilityConfigMap>` | `{}` |
 * | `targets` | `readonly Target[]` | `hostTargets(process.platform)` — one desktop target, mobile is opt-in |
 * | `projectDir` | `string` | `".moku/tauri"` — generated Tauri project (gitignored build output) |
 * | `outDir` | `string` | `"dist-native"` — installer delivery root |
 * | `signing` | `SigningConfig` | `{}` — identifiers and env-var NAMES only, never secrets |
 *
 * Per-plugin config (`pluginConfigs`) — each plugin's own defaults, all seams `undefined`
 * so the real implementation runs unless a test injects one:
 *
 * | Plugin | Field | Default | What it is |
 * |---|---|---|---|
 * | `tauri` | `spawnImpl` | `undefined` | injectable spawn; real = detached process-group spawn |
 * | `tauri` | `nodePath` | `undefined` | explicit `node` path; real = PATH walk (never `process.execPath`, which is bun here) |
 * | `tauri` | `readiness` | `{ intervalMs: 250, timeoutMs: 60_000 }` | `dev()`'s devUrl poll cadence (no stdout ready marker exists — tauri#4740) |
 * | `doctor` | `probeImpl` | `undefined` | injectable probe runner; real = `which`/`--version` subprocesses |
 * | `cli` | `renderImpl` | `undefined` | injectable render sink; real = branded console (MC1) |
 * | `cli` | `confirmImpl` | `undefined` | injectable confirm; real = styled branded confirm (gates a full `clean()`) |
 * | `env` (core) | `providers` | `[workerSafeProcessEnv()]` | seeded in `src/config.ts`; overriding REPLACES the list, so re-add it |
 * @example
 * ```ts
 * import { createApp } from "@moku-labs/native";
 * import { systemPlugins } from "./system";
 *
 * export const native = createApp({
 *   config: {
 *     app: { name: "MyApp", identifier: "com.example.myapp", icon: "assets/icon.png" },
 *     system: systemPlugins,
 *     targets: ["macos", "ios"],
 *     signing: { apple: { teamId: "ABCDE12345", exportMethod: "app-store-connect" } }
 *   }
 * });
 *
 * await native.cli.build({ target: "macos" });
 * ```
 */
import { coreConfig, createCore } from "./config";
import { buildPlugin, cliPlugin, doctorPlugin, projectPlugin, tauriPlugin } from "./plugins";

const framework = createCore(coreConfig, {
  // Dependency order: project/tauri → build/doctor → cli. Every plugin's own defaults
  // live in its `src/plugins/<name>/index.ts`, so this call carries no pluginConfigs.
  plugins: [projectPlugin, tauriPlugin, buildPlugin, doctorPlugin, cliPlugin]
});

// ─── Framework API ───────────────────────────────────────────
/**
 * Creates a native consumer app (Layer 3) from this framework.
 *
 * Wires the five framework plugins plus `log`/`env`, validates app identity at
 * composition time, and returns the frozen, fully-typed app. See the file JSDoc above
 * for the full options/defaults tables.
 *
 * @example
 * ```ts
 * export const native = createApp({ config: { app: { name: "MyApp", identifier: "com.example.myapp" } } });
 * ```
 */
export const createApp = framework.createApp;

/**
 * Creates a consumer-authored plugin bound to this framework's chain.
 *
 * @example
 * ```ts
 * const myPlugin = createPlugin("my", { api: () => ({}) });
 * ```
 */
export const createPlugin = framework.createPlugin;

// ─── Plugins + Plugin Types ──────────────────────────────────
export * from "./plugins";

// ─── Helpers + Constants ─────────────────────────────────────
export { hostTargets, PHASE_ORDER, TARGETS } from "./config";
// The one runtime value a plugin namespace cannot carry: the plugin type namespaces are
// type-only (`export type * as Tauri`), so the error class is exported by name here.
export { TauriError } from "./plugins/tauri/errors";

// ─── Types ───────────────────────────────────────────────────
export type {
  AppleExportMethod,
  AppleSigning,
  CapabilityConfigMap,
  Config,
  Events,
  NativeCompleteEvent,
  NativePhase,
  NativePhaseEvent,
  PluginApiOf,
  PluginLike,
  RequireFn,
  SigningConfig,
  Target
} from "./config";
