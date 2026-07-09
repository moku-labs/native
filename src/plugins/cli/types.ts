/**
 * @file cli plugin — type definitions.
 */
import type { Config as GlobalConfig, NativePhase, Target } from "../../config";

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
 * Structural mirror of `@moku-labs/core`'s unexported `PluginLike` — same field shape
 * (`name`/`spec`/`_phantom`), so a real plugin instance (e.g. `projectPlugin`) satisfies
 * it without importing a core-internal type. Re-derived locally per the house pattern
 * established by the sibling `build`/`doctor` plugins' `types.ts` (moku-testing
 * mock-context.md; spec/04 §Dependencies).
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
 * Domain context shared by the cli plugin's `api` and `hooks` factories. Structural
 * composition (not the bare `PluginCtx` export): cli genuinely needs `require` — its four
 * dependencies are project/tauri/build/doctor (D-007) — alongside the mutable render-progress
 * `state` and the injectable render/confirm seams on `config`.
 */
export type CliContext = {
  readonly global: Readonly<GlobalConfig>;
  readonly config: Readonly<Config>;
  state: State;
  readonly require: <P extends PluginLike>(plugin: P) => PluginApiOf<P>;
};
