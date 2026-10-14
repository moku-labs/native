/**
 * @file build plugin — type definitions.
 */

import type { LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type {
  BuildFlavor,
  BuildProfile,
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
  /** `<outDir>/<target>` for a store build, `<outDir>/<target>-debug` for a debug one. */
  outPath: string;
  artifacts: readonly string[];
  durationMs: number;
  phases: readonly PhaseTiming[];
  /** The profile the artifacts were built in — the same value `native:complete` carries. */
  profile: BuildProfile;
};

/** Options for a prepare pass: the target, and `debug` for the debug profile (Android only). */
export type PrepareOptions = { target: Target; debug?: boolean | undefined };

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
    | "patchMobileIcons"
    | "detectPageAgent"
    | "checkShellLinked"
  >;
  readonly tauri: Pick<TauriApi, "build" | "mobileInit" | "icon" | "getRunner">;
};

/** Public API of the build plugin — the per-target pipeline orchestrator. */
export type Api = {
  /**
   * Brings the generated project to a buildable state — scaffold, codegen, icons — and stops
   * there, in the store profile or, with `debug`, the debug one. `dev` calls it before
   * handing the tree to `tauri dev`, so a dev session never compiles a stale tree.
   *
   * @param opts - The target to prepare, and `debug` for the debug profile.
   * @returns Nothing; the tree under `projectDir` is ready for the build verb.
   * @throws {Error} `[native] --debug builds Android only for now (asked for <target>).` when
   *   `debug` is set for any target but android — before any phase runs.
   * @example
   * ```ts
   * // The cli's dev command prepares the debug tree of the phone build: the shell crate is
   * // generated and the debug patches are applied, nothing is compiled.
   * await ctx.require(buildPlugin).prepare({ target: "android", debug: true });
   * ```
   */
  prepare(opts: PrepareOptions): Promise<void>;
  /**
   * Runs the full `scaffold → codegen → icons → compile → bundle → collect` pipeline for one
   * target, emitting `native:phase` per phase and `native:complete` on success. A store build
   * whose page carries the editor agent is refused after the compile, before anything is
   * collected; a debug build is delivered into `<outDir>/<target>-debug`, beside the store one.
   *
   * @param opts - The target plus the platform flags (`simulator`, `aab`, `debug`).
   * @returns The completed pipeline's result.
   * @throws {Error} The first failing phase's error; `[native] --debug builds Android only …`
   *   for `debug` on another target, before any phase.
   * @example
   * ```ts
   * // A debug build for the phone, installed beside the store app.
   * const result = await app.build.run({ target: "android", debug: true });
   * // result.outPath === "dist-native/android-debug", result.profile === "debug"
   * ```
   */
  run(opts: RunOptions): Promise<BuildResult>;
  /**
   * Runs the pipeline sequentially for every target in `opts.targets` (default: the configured
   * `targets`), stopping at the first failing target. With `debug`, every target is checked up
   * front and the whole run is refused when one is not android — nothing is half-built.
   *
   * @param opts - The targets plus the platform flags threaded into every run.
   * @returns Every completed target's result, in target order.
   * @throws {Error} Whatever the first failing target's pipeline throws.
   * @example
   * ```ts
   * // targets: ["android"] in the app config
   * const [phone] = await app.build.runAll({ debug: true });
   * // phone.profile === "debug", phone.outPath === "dist-native/android-debug"
   * ```
   */
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
