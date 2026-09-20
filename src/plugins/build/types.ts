/**
 * @file build plugin — type definitions.
 */

import type { LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type {
  BuildFlavor,
  Events,
  Config as GlobalConfig,
  NativePhase,
  Target
} from "../../config";
import type { projectPlugin } from "../project";
import type { Api as ProjectApi } from "../project/types";
import type { tauriPlugin } from "../tauri";
import type { Api as TauriApi } from "../tauri/types";

/** One pipeline phase's measured duration, in execution order. */
export type PhaseTiming = { phase: NativePhase; durationMs: number };

/** Result of one target's full pipeline pass — `phases` always carries all six entries. */
export type BuildResult = {
  target: Target;
  outPath: string;
  artifacts: readonly string[];
  durationMs: number;
  phases: readonly PhaseTiming[];
};

/** Options for one target's pipeline pass. Platform-specific flags are ignored elsewhere. */
export type RunOptions = BuildFlavor & { target: Target };

/** Options for a sequential multi-target pass (default targets: `ctx.global.targets`). */
export type RunAllOptions = BuildFlavor & { targets?: readonly Target[] | undefined };

/**
 * The dependency API slices the pipeline calls, resolved ONCE in `createBuildApi` and
 * threaded through every phase — `Pick` rather than the whole `Api`, so the exact
 * cross-plugin surface build depends on (D-007) is readable in one place.
 */
export type BuildDeps = {
  readonly project: Pick<
    ProjectApi,
    "generate" | "completeness" | "patchMobile" | "ensureIconSource"
  >;
  readonly tauri: Pick<TauriApi, "build" | "mobileInit" | "icon" | "runner">;
};

/** Public API of the build plugin — the per-target pipeline orchestrator. */
export type Api = {
  prepare(opts: { target: Target }): Promise<void>;
  run(opts: RunOptions): Promise<BuildResult>;
  runAll(opts?: RunAllOptions): Promise<readonly BuildResult[]>;
};

/**
 * Domain context for the build plugin's pipeline: core's `PluginCtx` (build declares no
 * config and no state, and emits the framework's own `Events`) plus `global`, the `log`
 * core API (MC2), and a `require` constrained to build's real dependencies — `project` and
 * `tauri` (D-007).
 */
export type BuildContext = PluginCtx<Record<string, never>, Record<string, never>, Events> & {
  readonly global: Readonly<GlobalConfig>;
  readonly log: LogApi;
  /**
   * Resolves a dependency plugin's API. The constraint IS build's dependency list, and the
   * API type is read off the resolved instance's own phantom slot — no mirror of core's
   * registry types, and no plugin outside `depends` can be required by accident.
   *
   * @param plugin - `projectPlugin` or `tauriPlugin`.
   * @returns That plugin's public API.
   */
  require<P extends typeof projectPlugin | typeof tauriPlugin>(plugin: P): P["_phantom"]["api"];
};
