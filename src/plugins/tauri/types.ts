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

/** tauri plugin per-plugin config — test seams (| undefined required under exactOptionalPropertyTypes). */
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

/** Options for `Api.build` — the argv options plus the live output/progress callbacks. */
export type BuildOptions = BuildArgvOptions & {
  onTick?: ((tick: CompileTick) => void) | undefined;
  onOutput?: ((line: string) => void) | undefined;
};

/** How a dev session ended. */
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

/** Mutable plugin state — the one live dev handle (undefined = no live session; unicorn/no-null). */
export type State = { dev: DevHandle | undefined };

/** Public API of the tauri plugin — the framework's ONLY subprocess seam. */
export type Api = {
  icon(opts: { source: string }): Promise<RunResult>;
  build(opts: BuildOptions): Promise<RunResult>;
  mobileInit(opts: { target: MobileTarget }): Promise<RunResult>;
  dev(opts: {
    target?: Target | undefined;
    onOutput?: ((line: string) => void) | undefined;
  }): Promise<DevHandle>;
  getVersion(): Promise<{ cliVersion: string } | undefined>;
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
