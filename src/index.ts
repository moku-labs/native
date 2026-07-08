// biome-ignore-all assist/source/organizeImports: grouped export sections (Plugins → Config → Framework API) are house style (D-010)
/**
 * @file `@moku-labs/native` — node-only native packager framework for Moku (Tauri 2).
 */
import { coreConfig, createCore } from "./config";
import { buildPlugin, cliPlugin, doctorPlugin, projectPlugin, tauriPlugin } from "./plugins";

const framework = createCore(coreConfig, {
  // Dependency order: project/tauri (Wave 1) → build/doctor (Wave 2) → cli (Wave 3).
  plugins: [projectPlugin, tauriPlugin, buildPlugin, doctorPlugin, cliPlugin],
  // Framework default plugin configuration.
  // Consumer apps override specific values via createApp({ pluginConfigs: { ... } }).
  pluginConfigs: {
    /**
     * tauri — the `@tauri-apps/cli` subprocess seam.
     * - `spawnImpl`: injectable spawn for tests; `undefined` → real detached process-group spawn.
     * - `nodePath`: explicit `node` binary path; `undefined` → PATH-walk resolution (never
     *   `process.execPath`, which is bun here).
     * - `readiness`: `tauri.dev()`'s devUrl poll cadence — no stdout "ready" marker exists
     *   (tauri#4740), so polling is the only readiness signal.
     *
     * @example
     * ```ts
     * createApp({ pluginConfigs: { tauri: { readiness: { intervalMs: 100, timeoutMs: 30_000 } } } });
     * ```
     */
    tauri: {
      spawnImpl: undefined,
      nodePath: undefined,
      readiness: { intervalMs: 250, timeoutMs: 60_000 }
    }
    // (doctor/cli seams land with their build waves)
  }
});

// ─── Plugins + Types ──────────────────────────────────────────
export * from "./plugins";

// ─── Shared Config Types + Constants ─────────────────────────
export { PHASE_ORDER, TARGETS } from "./config";
export type {
  CapabilityConfigMap,
  Config,
  Events,
  NativeCompleteEvent,
  NativePhase,
  NativePhaseEvent,
  SigningConfig,
  Target
} from "./config";

// ─── Framework API + Plugin Helpers ──────────────────────────
/**
 * Creates a native consumer app (Layer 3) from this framework.
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
