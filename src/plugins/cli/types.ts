/**
 * @file cli plugin — type definitions.
 */
import type { BrandConsole } from "@moku-labs/common/cli";
import type { Config as GlobalConfig, RequireFn, Target } from "../../config";

/** Structural render sink — injectable for tests (default: branded `@moku-labs/common/cli` console). */
export type RenderFn = (line: string) => void;

/** Structural confirm seam — injectable for tests (default: styled confirm from the branded kit). */
export type ConfirmFn = (question: string) => Promise<boolean>;

/** cli plugin per-plugin config (| undefined required under exactOptionalPropertyTypes). */
export type Config = {
  renderImpl?: RenderFn | undefined;
  confirmImpl?: ConfirmFn | undefined;
};

/**
 * Plugin state: the one branded console every verb and hook renders through (created
 * once in `createState` — N5) plus the live-render bookkeeping for the current verb
 * invocation (`startedAt: undefined` = no phase running; unicorn/no-null).
 */
export type State = {
  readonly ui: BrandConsole;
  progress: { startedAt: number | undefined };
};

/** Public API of the cli plugin — typed verbs, NO argv parsing. */
export type Api = {
  build(opts?: {
    target?: Target;
    all?: boolean;
    simulator?: boolean | undefined;
    aab?: boolean | undefined;
  }): Promise<void>;
  dev(opts?: { target?: Target }): Promise<void>;
  doctor(opts?: { target?: Target }): Promise<boolean>;
  clean(opts?: { target?: Target }): Promise<void>;
};

/**
 * Context the `createState` factory receives (core's MinimalContext tier: the global
 * config plus this plugin's RESOLVED config — which is where the injected render seam
 * arrives, so the branded console can be built once, up front).
 */
export type CliStateContext = {
  readonly global: Readonly<GlobalConfig>;
  readonly config: Readonly<Config>;
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
