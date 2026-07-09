/**
 * @file doctor plugin — type definitions.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { EmitFn } from "@moku-labs/core";
import type { Config as GlobalConfig, Target } from "../../config";

/** Structural probe seam — injectable for tests. */
export type ProbeFn = (
  cmd: string,
  args: readonly string[]
) => Promise<{ code: number; stdout: string }>;

/** doctor plugin per-plugin config (| undefined required under exactOptionalPropertyTypes). */
export type Config = {
  probeImpl?: ProbeFn | undefined;
};

/** One completed check — also the doctor:check event payload. */
export type CheckResult = {
  id: string;
  target: Target | "host";
  status: "pass" | "warn" | "fail";
  message: string;
  fixIt?: string;
};

/** Aggregated diagnosis report (warns don't flip ok; fails do). */
export type DoctorReport = {
  ok: boolean;
  checks: readonly CheckResult[];
};

/** Events this plugin declares (spec/14 §2 register callback pattern). */
export type DoctorEvents = {
  "doctor:check": CheckResult;
};

/**
 * Structural mirror of `@moku-labs/core`'s unexported `PluginLike` — same field shape
 * (`name`/`spec`/`_phantom`), so a real plugin instance (e.g. `projectPlugin`) satisfies
 * it without importing a core-internal type. `PluginCtx`'s own JSDoc anticipates this:
 * "for advanced composition (e.g. adding require), use EmitFn<E> directly" — this is the
 * `require`-side equivalent, re-derived locally since core intentionally exports only
 * `PluginCtx`/`EmitFn` for domain composition (moku-testing mock-context.md; house style
 * established by the sibling `build` plugin's `types.ts`, spec/04 §Dependencies).
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
 * Domain context for the doctor API factory. Structural composition (mock-context.md
 * "advanced composition" case): doctor genuinely needs `require` — its two dependencies
 * are `project` and `tauri` (D-007) — alongside `global` and the `log`/`env` core APIs
 * (MC2/MC3). No `state` field: doctor has none (spec/04 §State).
 */
export type DoctorContext = {
  readonly global: Readonly<GlobalConfig>;
  readonly config: Readonly<Config>;
  readonly log: LogApi;
  readonly env: EnvApi;
  readonly emit: EmitFn<DoctorEvents>;
  readonly require: <P extends PluginLike>(plugin: P) => PluginApiOf<P>;
};

/** Public API of the doctor plugin. */
export type Api = {
  run(opts?: { target?: Target }): Promise<DoctorReport>;
};
