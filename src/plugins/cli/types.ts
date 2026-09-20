/**
 * @file cli plugin — type definitions.
 */
import type { BrandConsole } from "@moku-labs/common/cli";
import type { PluginCtx } from "@moku-labs/core";
import type { BuildFlavor, Config as GlobalConfig, Target } from "../../config";
import type { Api as BuildApi } from "../build/types";
import type { Api as DoctorApi } from "../doctor/types";
import type { Api as ProjectApi } from "../project/types";
import type { Api as TauriApi } from "../tauri/types";

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
 * console), plus `global`. cli emits nothing of its own, and it holds no `require`: the four
 * dependency APIs are resolved once at the wiring point and travel as {@link CliDeps}.
 */
export type CliContext = PluginCtx<Config, State> & {
  readonly global: Readonly<GlobalConfig>;
};

/**
 * The dependency API slices the verbs delegate to — cli depends on exactly
 * project/tauri/build/doctor (D-007), and every verb is a thin delegate, so the surface it
 * actually calls is this narrow.
 */
export type CliDeps = {
  readonly project: Pick<ProjectApi, "clean">;
  readonly tauri: Pick<TauriApi, "dev">;
  readonly build: BuildApi;
  readonly doctor: DoctorApi;
};
