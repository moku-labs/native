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
 * invocation (`startedAt: undefined` = no phase running; unicorn/no-null). `startedAt` is a
 * `performance.now()` reading (monotonic, not epoch ms), so it only makes sense as the
 * start of an elapsed-time difference.
 */
export type State = {
  readonly ui: BrandConsole;
  progress: { startedAt: number | undefined };
};

/** Public API of the cli plugin — typed verbs, NO argv parsing. */
export type Api = {
  /**
   * Builds one target (default: the host target) or every configured target with
   * `{ all: true }` (which ignores any given `target`). The flavor flags pass straight
   * through to `build.run`/`build.runAll`. Progress renders live through the plugin's
   * `native:phase`/`native:complete` hooks — a debug delivery is marked
   * `debug build → <outPath>` in the completion panel, a dev delivery reads like a store one.
   * A failure (the store refusal of an editor-agent page included) renders the scrubbed stderr
   * tail before the `[native]` error line, then rethrows unchanged.
   *
   * @param opts - Build options.
   * @param opts.target - The packaging target (default: the resolved host target).
   * @param opts.all - Build every configured target instead of one (ignores `target`).
   * @param opts.simulator - iOS: build for the host's simulator arch instead of a device archive.
   * @param opts.aab - Android: emit a store bundle (`.aab`) instead of an `.apk`.
   * @param opts.debug - Build the debug profile (Android, iOS), delivered to `<outDir>/<target>-debug`.
   * @param opts.dev - Build the dev profile: the store build a tester installs, agent allowed.
   * @returns Resolves once the build (or all builds) complete.
   * @throws {Error} Whatever the pipeline throws — after rendering the failure.
   *   `[native] --debug builds Android and iOS only …` when `debug` is set with another target
   *   (or `all: true` with another target); `[native] debug and dev cannot be combined.` for
   *   both flags together.
   * @example
   * ```ts
   * // A debug build for the phone, installed beside the store app; the completion panel
   * // reads "debug build → dist-native/android-debug".
   * await app.cli.build({ target: "android", debug: true });
   * // The bundle a tester gets from the Play track, in dist-native/android.
   * await app.cli.build({ target: "android", aab: true, dev: true });
   * // Every configured target, store profile.
   * await app.cli.build({ all: true });
   * ```
   */
  build(
    opts?: BuildFlavor & { target?: Target | undefined; all?: boolean | undefined }
  ): Promise<void>;
  /**
   * Runs the dev loop. Brings the generated project to a buildable state first —
   * `build.prepare` runs scaffold → codegen → icons, so `tauri dev` never meets a
   * half-generated tree, and a failure there renders exactly like a failed build — then
   * awaits the dev handle's `ready` and `exited`. It NEVER stores the handle and NEVER calls
   * `stop()` itself (D-002); teardown is owned by the tauri seam (signal handlers,
   * process-group kill).
   *
   * @param opts - Dev options.
   * @param opts.target - Packaging target (default: the resolved host target).
   * @returns Resolves once the dev session exits cleanly (a Ctrl-C exit included).
   * @throws {Error} `[native]` when the host has no desktop target, or when the dev
   *   session exits with a non-zero code.
   * @example
   * ```ts
   * // Live-reload the app in the iOS simulator until Ctrl-C.
   * await app.cli.dev({ target: "ios" });
   * ```
   */
  dev(opts?: { target?: Target | undefined }): Promise<void>;
  /**
   * Runs diagnosis, renders the summary, and returns whether every check passed. The
   * per-check rows (with their fix-its) print exactly once, live from this plugin's
   * `doctor:check` hook; this method adds only the counts and the verdict.
   *
   * @param opts - Optional scoping.
   * @param opts.target - A single target to diagnose (default: every configured target + host).
   * @returns Whether the report is `ok` (no failing check) — the caller sets `process.exitCode`.
   * @example
   * ```ts
   * // A CI step that fails when the Android toolchain is incomplete.
   * if (!(await app.cli.doctor({ target: "android" }))) process.exitCode = 1;
   * ```
   */
  doctor(opts?: { target?: Target | undefined }): Promise<boolean>;
  /**
   * Cleans derived state. Without a `target`, this wipes the ENTIRE project directory —
   * gated behind a styled confirm — before delegating to `project.clean` (D-006: project
   * owns the destructive filesystem knowledge, cli is a thin delegate).
   *
   * @param opts - Clean options.
   * @param opts.target - A single target to clean (default: confirm, then wipe everything).
   * @returns Resolves once cleaning completes (or immediately, if the user declines).
   * @example
   * ```ts
   * // Regenerate only the Android tree on the next build; no confirm is asked.
   * await app.cli.clean({ target: "android" });
   * ```
   */
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
