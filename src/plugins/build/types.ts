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
import type { Api as ProjectApi } from "../project/types";
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
 * Resolves a path to the comparable form containment is measured in — real path, symlinks
 * followed, case folded. Always `project.resolveDerivedPath`: the project plugin owns that
 * rule, and the collect guard must answer exactly what the clean guard answers.
 */
export type PathResolver = (target: string) => string;

/**
 * The dependency API slices the pipeline calls, resolved ONCE in `createBuildApi` and
 * threaded through every phase — `Pick` rather than the whole `Api`, so the exact
 * cross-plugin surface build depends on (D-007) is readable in one place.
 */
export type BuildDeps = {
  readonly project: Pick<
    ProjectApi,
    | "generate"
    | "getBundleLayout"
    | "getCompleteness"
    | "patchMobile"
    | "clearMobileBuildOutput"
    | "ensureIconSource"
    | "resolveDerivedPath"
  >;
  readonly tauri: Pick<TauriApi, "build" | "mobileInit" | "icon" | "getRunner">;
};

/** Public API of the build plugin — the per-target pipeline orchestrator. */
export type Api = {
  prepare(opts: { target: Target }): Promise<void>;
  run(opts: RunOptions): Promise<BuildResult>;
  runAll(opts?: RunAllOptions): Promise<readonly BuildResult[]>;
};

/**
 * Domain context for the build plugin's pipeline: core's `PluginCtx` (build declares no
 * config and no state, and emits the framework's own `Events`) plus `global` and the `log`
 * core API (MC2). No `require`: the two dependency APIs are resolved once at the wiring
 * point by the real `ctx.require` and travel as {@link BuildDeps}.
 */
export type BuildContext = PluginCtx<Record<string, never>, Record<string, never>, Events> & {
  readonly global: Readonly<GlobalConfig>;
  readonly log: LogApi;
};
