/**
 * @file cli plugin — type definitions.
 */
import type { Config as GlobalConfig, NativePhase, RequireFn, Target } from "../../config";

/** Structural render sink — injectable for tests (default: branded `@moku-labs/common/cli` console). */
export type RenderFn = (line: string) => void;

/** Structural confirm seam — injectable for tests (default: styled confirm from the branded kit). */
export type ConfirmFn = (question: string) => Promise<boolean>;

/** cli plugin per-plugin config (| undefined required under exactOptionalPropertyTypes). */
export type Config = {
  renderImpl?: RenderFn | undefined;
  confirmImpl?: ConfirmFn | undefined;
};

/** Live-render bookkeeping for the current verb invocation (undefined = no active phase; unicorn/no-null). */
export type State = {
  progress: { phase: NativePhase | undefined; startedAt: number | undefined; ticks: number };
};

/** Public API of the cli plugin — typed verbs, NO argv parsing. */
export type Api = {
  build(opts?: { target?: Target; all?: boolean }): Promise<void>;
  dev(opts?: { target?: Target }): Promise<void>;
  doctor(opts?: { target?: Target }): Promise<boolean>;
  clean(opts?: { target?: Target }): Promise<void>;
};

/**
 * Domain context shared by the cli plugin's `api` and `hooks` factories. Structural
 * composition (not the bare `PluginCtx` export): cli genuinely needs `require` — its four
 * dependencies are project/tauri/build/doctor (D-007) — alongside the mutable render-progress
 * `state` and the injectable render/confirm seams on `config`. `RequireFn` is the
 * framework-shared mirror of core's unexported `PluginLike` (see `src/config.ts`).
 */
export type CliContext = {
  readonly global: Readonly<GlobalConfig>;
  readonly config: Readonly<Config>;
  state: State;
  readonly require: RequireFn;
};
