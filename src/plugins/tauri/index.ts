/**
 * Standard tier — `@tauri-apps/cli` subprocess seam: argv builders, injectable spawn,
 * process-group dev lifecycle, stream parsing, error taxonomy, secret scrubbing.
 *
 * NO onStop by design (D-002): spec/08 §2 TeardownContext = { global } — a regular plugin's
 * onStop cannot reach ctx.state, so dev teardown is owned by the dev seam's own control flow
 * (signal handlers + DevHandle.stop()), which also covers Ctrl-C where onStop never fires.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { createTauriApi } from "./api";
import { createTauriState } from "./state";
import type { Config } from "./types";

const defaultConfig: Config = {
  spawnImpl: undefined,
  nodePath: undefined,
  readiness: { intervalMs: 250, timeoutMs: 60_000 }
};

export const tauriPlugin = createPlugin("tauri", {
  config: defaultConfig,
  createState: createTauriState,
  api: createTauriApi
});
