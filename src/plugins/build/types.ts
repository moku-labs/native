/**
 * @file build plugin — type definitions.
 */

import type { LogApi } from "@moku-labs/common";
import type { EmitFn } from "@moku-labs/core";
import type { Events, Config as GlobalConfig, NativePhase, RequireFn, Target } from "../../config";

/** Result of one target's full pipeline pass. */
export type BuildResult = {
  target: Target;
  outPath: string;
  artifacts: readonly string[];
  durationMs: number;
  phases: ReadonlyArray<{ phase: NativePhase; durationMs: number }>;
};

/** Public API of the build plugin — the per-target pipeline orchestrator. */
export type Api = {
  run(opts: { target: Target }): Promise<BuildResult>;
  runAll(opts?: { targets?: readonly Target[] }): Promise<readonly BuildResult[]>;
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
