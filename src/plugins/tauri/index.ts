import { createPlugin } from "../../config";
import { createTauriApi } from "./api";
import { createTauriState } from "./state";
import type { Config } from "./types";

const defaultConfig: Config = {
  spawnImpl: undefined,
  nodePath: undefined,
  arch: undefined,
  readiness: { intervalMs: 250, timeoutMs: 60_000 }
};

/**
 * Complex tier (flat layout) — `@tauri-apps/cli` subprocess seam: argv builders, injectable
 * spawn, process-group dev lifecycle, stream parsing, error taxonomy, secret scrubbing.
 * Each concern is its own file next to this one; the ≤30-line wiring rule keeps the layout
 * flat rather than nested.
 *
 * NO onStop by design (D-002): teardown is owned by the dev seam (signal handlers +
 * DevHandle.stop()), which also covers Ctrl-C where onStop never fires.
 *
 * @see README.md
 * @example
 * ```ts
 * const app = createApp({ plugins: [tauriPlugin] });
 * ```
 */
export const tauriPlugin = createPlugin("tauri", {
  config: defaultConfig,
  createState: createTauriState,
  api: createTauriApi
});
