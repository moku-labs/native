/**
 * @file tauri plugin — type definitions (structural — never runtime-package namespace types).
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type {
  AppleExportMethod,
  BuildFlavor,
  Config as GlobalConfig,
  MobileTarget,
  Target,
  TauriRunner
} from "../../config";

/**
 * Structural spawn seam — injectable for tests (skeleton-conventions §3).
 * `signal` lets long-lived callers (the dev seam) request cancellation without
 * the caller ever touching a raw ChildProcess — the real implementation wires
 * it to a process-group kill escalation (spawn.ts).
 */
export type SpawnFn = (opts: {
  cmd: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  detached?: boolean;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}) => Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>;

/**
 * Per-plugin config of tauri: the readiness budget `dev` polls `web.devUrl` with, plus test
 * seams (spawn, node path, host arch) that fall back to the real host when `undefined`
 * (`| undefined` is required under exactOptionalPropertyTypes).
 *
 * @example
 * ```ts
 * // A slow first Rust compile: give the dev server three minutes to answer.
 * createApp({ pluginConfigs: { tauri: { readiness: { intervalMs: 250, timeoutMs: 180_000 } } } });
 * ```
 */
export type Config = {
  spawnImpl?: SpawnFn | undefined;
  nodePath?: string | undefined;
  /**
   * Host architecture the iOS simulator rust target is derived from. `undefined` reads the
   * real `process.arch`; pinning it keeps an assertion off the machine the suite runs on.
   */
  arch?: NodeJS.Architecture | undefined;
  readiness: { intervalMs: number; timeoutMs: number };
};

/** Result of a one-shot verb (non-zero exits throw TauriError instead). */
export type RunResult = { code: 0; stdout: string; stderr: string; durationMs: number };

/** Parsed compile progress tick — real crate counts, never fake percentages. */
export type CompileTick = { crate: string; index?: number; total?: number };

/**
 * The build verb's full option surface — everything that changes the argv: the target, the
 * shared {@link BuildFlavor} flags, and the iOS-only export method. A target that does not
 * use an option ignores it rather than failing (the build plugin passes whatever the
 * consumer configured, for every target).
 */
export type BuildArgvOptions = BuildFlavor & {
  target: Target;
  /** iOS: `--export-method` for a device build; ignored for a simulator build. */
  exportMethod?: AppleExportMethod | undefined;
};

/**
 * Options for `Api.build` — the argv options, the live output/progress callbacks, and extra
 * environment for the child process.
 */
export type BuildOptions = BuildArgvOptions & {
  onTick?: ((tick: CompileTick) => void) | undefined;
  onOutput?: ((line: string) => void) | undefined;
  /**
   * Extra environment for the spawned tauri CLI, merged over the inherited one — it reaches the
   * web build tauri runs (`beforeBuildCommand`), e.g. `{ MOKU_NATIVE_PROFILE: "debug" }`. Never
   * changes the argv. Omitted: the spawn call carries no `env` key at all.
   */
  env?: Readonly<Record<string, string>> | undefined;
};

/**
 * How a dev session ended: the exit code, or the signal that stopped it (`code: null`).
 *
 * @example
 * ```ts
 * // Ctrl-C stops the session through a signal: no code, and not a failure.
 * const exit: DevExit = { code: null, signal: "SIGTERM" };
 * ```
 */
export type DevExit = { code: number | null; signal: string | null };

/** Live dev-session handle — teardown is owned HERE (D-002), never by cli. */
export type DevHandle = {
  url: string;
  ready: Promise<void>;
  exited: Promise<DevExit>;
  stop(): Promise<void>;
};

/** Classified subprocess failure taxonomy. */
export type TauriErrorKind =
  | "toolchain-missing"
  | "platform-missing"
  | "config-invalid"
  | "compile-failed"
  | "xcode-script-failed"
  | "signing-failed"
  | "device-unavailable"
  | "cancelled"
  | "unknown";

/** Extra fields carried on a classified failure, alongside the standard `Error` shape. */
export type TauriErrorDetails = {
  /** The taxonomy bucket assigned by `errors.ts#classify`. */
  readonly kind: TauriErrorKind;
  /** Raw process exit code (`null` when the process was signal-terminated). */
  readonly exitCode: number | null;
  /**
   * Scrubbed tail of the run's output (secrets already masked) — safe to log/display.
   * Built from BOTH streams: the extracted cause lines, a `…` separator, then the last
   * raw lines.
   */
  readonly stderrTail: string;
};

// The class itself lives in errors.ts next to the classifier that constructs it; the
// namespace re-export (`export type * as Tauri`) is type-only, so consumers that need
// `instanceof` import the value by name from the package root.
export type { TauriError } from "./errors";

/**
 * Mutable plugin state: the one live dev handle, kept so a second `dev` call is refused
 * while a session runs; `undefined` when none is live (unicorn/no-null).
 */
export type State = { dev: DevHandle | undefined };

/** Public API of the tauri plugin — the framework's ONLY subprocess seam. */
export type Api = {
  /**
   * Regenerates the icon set from a source image (`tauri icon`) into
   * `<projectDir>/src-tauri/icons`.
   *
   * @param opts - Icon options.
   * @param opts.source - Path to the source icon image.
   * @returns The completed run's result.
   * @throws {Error} A classified `TauriError` on a non-zero exit.
   * @example
   * ```ts
   * // The build plugin's icons phase, with the source project.ensureIconSource() resolved.
   * const tauri = ctx.require(tauriPlugin);
   * await tauri.icon({ source: "/work/demo/assets/icon.png" }); // { code: 0, stdout, stderr, durationMs }
   * ```
   */
  icon(opts: { source: string }): Promise<RunResult>;

  /**
   * Runs `tauri build` / `tauri ios|android build` for the given target, streaming scrubbed
   * output and parsed compile ticks through the callbacks.
   *
   * @param opts - Build options (target, artifact flavour, progress callbacks, child env).
   * @param opts.target - Packaging target.
   * @param opts.simulator - iOS: build the host's simulator slice instead of a device archive.
   * @param opts.exportMethod - iOS device builds: the `--export-method` to archive with.
   * @param opts.aab - Android: emit a store bundle instead of the default installable APK.
   * @param opts.onTick - Called with parsed compile progress ("Compiling crate N/M").
   * @param opts.onOutput - Called with each scrubbed output line.
   * @param opts.env - Extra environment for the tauri CLI, merged over the inherited one, so
   *   the web build tauri runs (`beforeBuildCommand`) can read it. Never changes the argv: the
   *   debug and dev profiles are still release builds (no `--debug`).
   * @returns The completed run's result.
   * @throws {Error} A classified `TauriError` on a non-zero exit.
   * @example
   * ```ts
   * // The build plugin's compile phase: the web build reads MOKU_NATIVE_PROFILE, the APK stays --release.
   * const tauri = ctx.require(tauriPlugin);
   * await tauri.build({ target: "android", env: { MOKU_NATIVE_PROFILE: "debug" } });
   * // { code: 0, stdout, stderr, durationMs }
   * ```
   */
  build(opts: BuildOptions): Promise<RunResult>;

  /**
   * Runs `tauri ios|android init` — the ONLY init verbs (D-013). Callers must check that
   * `project.getCompleteness({ target })` reports `"not-initialized"` before calling this.
   *
   * @param opts - Mobile init options.
   * @param opts.target - Mobile target to initialize.
   * @returns The completed run's result.
   * @throws {Error} A classified `TauriError` on a non-zero exit.
   * @example
   * ```ts
   * // The build plugin's codegen pass initializes a mobile tree only when none exists yet.
   * const tauri = ctx.require(tauriPlugin);
   * if (ctx.require(projectPlugin).getCompleteness({ target: "ios" }).status === "not-initialized") {
   *   await tauri.mobileInit({ target: "ios" }); // writes <projectDir>/src-tauri/gen/apple
   * }
   * ```
   */
  mobileInit(opts: { target: MobileTarget }): Promise<RunResult>;

  /**
   * Starts the long-lived dev verb (`tauri dev` / `tauri ios|android dev`). Returns at once
   * with a live handle — never awaits `exited` itself.
   *
   * @param opts - Dev options.
   * @param opts.target - Optional packaging target (desktop-uniform when omitted).
   * @param opts.onOutput - Called with each scrubbed output line (cli renders these; defaults to log-only).
   * @returns The live dev handle.
   * @throws {Error} `[native]` when a dev session is already running.
   * @example
   * ```ts
   * // The cli's dev command: wait for the dev server, then for the session to end.
   * const handle = await ctx.require(tauriPlugin).dev({ target: "ios", onOutput: line => ui.line(line) });
   * await handle.ready; // web.devUrl answered
   * await handle.exited; // code: null after Ctrl-C — a signal ended it, the normal end
   * ```
   */
  dev(opts: {
    target?: Target | undefined;
    onOutput?: ((line: string) => void) | undefined;
  }): Promise<DevHandle>;

  /**
   * Probes CLI presence/version via `tauri info` — used by `doctor`.
   *
   * @returns The parsed CLI version, or `undefined` when the CLI can't be invoked.
   * @example
   * ```ts
   * // doctor's tauri-cli check: the one probe routed through the tauri plugin.
   * const version = await ctx.require(tauriPlugin).getVersion();
   * version?.cliVersion; // "2.11.4", or undefined when `tauri info` cannot run
   * ```
   */
  getVersion(): Promise<{ cliVersion: string } | undefined>;

  /**
   * Returns the resolved `node` + `tauri.js` pair every verb spawns with, so
   * `project.patchMobile` can write the same invocation into the generated Xcode/Gradle
   * build scripts (tauri emits a bare `node tauri`, which does not exist).
   *
   * @returns The resolved invocation prefix.
   * @throws {Error} `[native]` when `node` or the tauri CLI cannot be resolved.
   * @example
   * ```ts
   * // The build plugin's codegen pass, after the mobile init.
   * const runner = ctx.require(tauriPlugin).getRunner(); // { nodePath: "/usr/local/bin/node", tauriJsPath: "…/@tauri-apps/cli/tauri.js" }
   * await ctx.require(projectPlugin).patchMobile({ target: "ios", runner, profile: "store" });
   * ```
   */
  getRunner(): TauriRunner;
};

/**
 * Domain context shared by every tauri domain file: core's `PluginCtx` over this plugin's
 * own config/state (it declares no events) plus the three fields core composes in per
 * framework — `global` (projectDir, web.devUrl) and the `log`/`env` core APIs (MC2/MC3).
 */
export type TauriContext = PluginCtx<Config, State> & {
  readonly global: Readonly<GlobalConfig>;
  readonly log: LogApi;
  readonly env: EnvApi;
};
