/**
 * @file build plugin — type definitions.
 */

import type { LogApi } from "@moku-labs/common";
import type { EmitFn } from "@moku-labs/core";
import type { Events, Config as GlobalConfig, NativePhase, RequireFn, Target } from "../../config";
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
export type RunOptions = {
  target: Target;
  /** iOS: build for the host's simulator arch instead of a signed device archive. */
  simulator?: boolean | undefined;
  /** Android: emit a store bundle (`.aab`) instead of the default installable `.apk`. */
  aab?: boolean | undefined;
};

/** Options for a sequential multi-target pass (default targets: `ctx.global.targets`). */
export type RunAllOptions = {
  targets?: readonly Target[] | undefined;
  simulator?: boolean | undefined;
  aab?: boolean | undefined;
};

/**
 * The dependency API slices the pipeline calls, resolved ONCE in `createBuildApi` (N3)
 * and threaded through every phase — `Pick` rather than the whole `Api`, so the exact
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
 * Domain context for the build plugin's pipeline. Structural (not the bare `PluginCtx`
 * export) because this plugin genuinely needs `require` — build's only two dependencies
 * are `project` and `tauri` (D-007) — alongside `global` and the `log` core API (MC2).
 * No `config`/`state` fields: build has neither (spec/03 §Config, §State). `RequireFn`
 * is the framework-shared mirror of core's unexported `PluginLike` (see `src/config.ts`).
 */
export type BuildContext = {
  readonly global: Readonly<GlobalConfig>;
  readonly log: LogApi;
  readonly emit: EmitFn<Events>;
  readonly require: RequireFn;
};
