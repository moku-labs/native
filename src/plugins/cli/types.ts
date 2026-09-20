/**
 * @file cli plugin — type definitions.
 */
import type { BrandConsole } from "@moku-labs/common/cli";
import type { PluginCtx } from "@moku-labs/core";
import type { BuildFlavor, Config as GlobalConfig, Target } from "../../config";
import type { buildPlugin } from "../build";
import type { doctorPlugin } from "../doctor";
import type { projectPlugin } from "../project";
import type { tauriPlugin } from "../tauri";

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
 * once in `createState`) plus the live-render bookkeeping for the current verb
 * invocation (`startedAt: undefined` = no phase running; unicorn/no-null).
 */
export type State = {
  readonly ui: BrandConsole;
  progress: { startedAt: number | undefined };
};

/** Public API of the cli plugin — typed verbs, NO argv parsing. */
export type Api = {
  build(
    opts?: BuildFlavor & { target?: Target | undefined; all?: boolean | undefined }
  ): Promise<void>;
  dev(opts?: { target?: Target | undefined }): Promise<void>;
  doctor(opts?: { target?: Target | undefined }): Promise<boolean>;
  clean(opts?: { target?: Target | undefined }): Promise<void>;
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
 * Domain context shared by the cli plugin's `api` and `hooks` factories: core's `PluginCtx`
 * over this plugin's config (the render/confirm seams) and state (the shared branded
 * console), plus `global` and one `require` overload per real dependency — cli depends on
 * exactly project/tauri/build/doctor (D-007). cli emits nothing of its own.
 */
export type CliContext = PluginCtx<Config, State> & {
  readonly global: Readonly<GlobalConfig>;
  /**
   * Resolves a dependency plugin's API. The constraint IS cli's dependency list, and the
   * API type is read off the resolved instance's own phantom slot — no mirror of core's
   * registry types.
   *
   * @param plugin - `projectPlugin`, `tauriPlugin`, `buildPlugin` or `doctorPlugin`.
   * @returns That plugin's public API.
   */
  require<
    P extends typeof projectPlugin | typeof tauriPlugin | typeof buildPlugin | typeof doctorPlugin
  >(plugin: P): P["_phantom"]["api"];
};
