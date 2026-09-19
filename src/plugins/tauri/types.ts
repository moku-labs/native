/**
 * @file tauri plugin — type definitions (structural — never runtime-package namespace types).
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { AppleExportMethod, Config as GlobalConfig, Target } from "../../config";

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
  readiness: { intervalMs: number; timeoutMs: number };
};

/** Result of a one-shot verb (non-zero exits throw TauriError instead). */
export type RunResult = { code: 0; stdout: string; stderr: string; durationMs: number };

/** Parsed compile progress tick — real crate counts, never fake percentages. */
export type CompileTick = { crate: string; index?: number; total?: number };

/**
 * The resolved D-013 invocation prefix. Exposed on the Api so `project.patchMobile`
 * can write the SAME `node <tauri.js>` pair into the generated Xcode/Gradle scripts,
 * where tauri's own generator emits a bare `node tauri` that does not exist (B10).
 */
export type Runner = { nodePath: string; tauriJsPath: string };

/**
 * The build verb's full option surface — everything that changes the argv.
 * `simulator`/`exportMethod` are iOS-only, `aab` is Android-only; a target that
 * does not use an option ignores it rather than failing (the build plugin passes
 * whatever the consumer configured, for every target).
 */
export type BuildArgvOptions = {
  target: Target;
  /** iOS: build for the host's simulator arch instead of a device. */
  simulator?: boolean | undefined;
  /** iOS: `--export-method` for a device build; ignored for a simulator build. */
  exportMethod?: AppleExportMethod | undefined;
  /** Android: emit a store bundle (`--aab`) instead of the default installable `--apk`. */
  aab?: boolean | undefined;
};

/** Options for `Api.build` — the argv options plus the live output/progress callbacks. */
export type BuildOptions = BuildArgvOptions & {
  onTick?: (tick: CompileTick) => void;
  onOutput?: (line: string) => void;
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
  mobileInit(opts: { target: "ios" | "android" }): Promise<RunResult>;
  dev(opts: { target?: Target; onOutput?: (line: string) => void }): Promise<DevHandle>;
  version(): Promise<{ cliVersion: string } | null>;
  runner(): Runner;
};

/**
 * Domain context shared by every tauri domain file. Structural composition
 * (not the bare `PluginCtx` export) because this plugin needs `global`
 * (projectDir, web.devUrl) and the `log`/`env` core APIs alongside
 * `config`/`state` — see moku-testing's mock-context.md §Standard Factory.
 */
export type TauriContext = {
  readonly global: Readonly<GlobalConfig>;
  readonly config: Readonly<Config>;
  state: State;
  readonly log: LogApi;
  readonly env: EnvApi;
};
