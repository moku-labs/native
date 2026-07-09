/**
 * @file build plugin — type definitions.
 */

import type { LogApi } from "@moku-labs/common";
import type { EmitFn } from "@moku-labs/core";
import type { Events, Config as GlobalConfig, NativePhase, Target } from "../../config";

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
 * Structural mirror of `@moku-labs/core`'s unexported `PluginLike` — same field shape
 * (`name`/`spec`/`_phantom`), so a real plugin instance (e.g. `projectPlugin`) satisfies
 * it without importing a core-internal type. `PluginCtx`'s own JSDoc anticipates this:
 * "for advanced composition (e.g. adding require), use EmitFn<E> directly" — this is the
 * `require`-side equivalent, re-derived locally since core intentionally exports only
 * `PluginCtx`/`EmitFn` for domain composition (moku-testing mock-context.md).
 */
type PluginLike = {
  readonly name: string;
  readonly spec: unknown;
  readonly _phantom: {
    readonly config: unknown;
    readonly state: unknown;
    readonly api: unknown;
    readonly events?: Record<string, unknown>;
  };
};

/** Extracts a plugin-like value's API type from its phantom `api` slot. */
type PluginApiOf<P extends PluginLike> = P extends { readonly _phantom: { readonly api: infer A } }
  ? A
  : never;

/**
 * Domain context for the build plugin's pipeline. Structural (not the bare `PluginCtx`
 * export) because this plugin genuinely needs `require` — build's only two dependencies
 * are `project` and `tauri` (D-007) — alongside `global` and the `log` core API (MC2).
 * No `config`/`state` fields: build has neither (spec/03 §Config, §State).
 */
export type BuildContext = {
  readonly global: Readonly<GlobalConfig>;
  readonly log: LogApi;
  readonly emit: EmitFn<Events>;
  readonly require: <P extends PluginLike>(plugin: P) => PluginApiOf<P>;
};
