/**
 * @file tauri plugin — type definitions (structural — never runtime-package namespace types).
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { Config as GlobalConfig, Target } from "../../config";

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
  | "config-invalid"
  | "compile-failed"
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
  /** Scrubbed tail of stderr (secrets already masked) — safe to log/display. */
  readonly stderrTail: string;
};

/**
 * Thrown by every one-shot verb (`icon`/`build`/`mobileInit`) on a non-zero exit.
 * Carries a classified {@link TauriErrorKind} and the scrubbed stderr tail so
 * callers (`build`, `doctor`, `cli`) can render an actionable message without
 * re-deriving the taxonomy or re-scrubbing raw output.
 */
export class TauriError extends Error implements TauriErrorDetails {
  readonly kind: TauriErrorKind;
  readonly exitCode: number | null;
  readonly stderrTail: string;

  /**
   * Constructs a classified `TauriError`.
   *
   * @param kind - Taxonomy bucket.
   * @param message - Fully formatted `[native] ...` message.
   * @param details - Exit code + scrubbed stderr tail.
   * @param details.exitCode - Raw process exit code (`null` when signal-terminated).
   * @param details.stderrTail - Scrubbed tail of stderr — already safe to log/display.
   * @example
   * ```ts
   * throw new TauriError("compile-failed", "[native] tauri compile failed.\n  See stderr.", {
   *   exitCode: 101,
   *   stderrTail: "error[E0432]: unresolved import `foo`",
   * });
   * ```
   */
  constructor(
    kind: TauriErrorKind,
    message: string,
    details: { exitCode: number | null; stderrTail: string }
  ) {
    super(message);
    this.name = "TauriError";
    this.kind = kind;
    this.exitCode = details.exitCode;
    this.stderrTail = details.stderrTail;
  }
}

/** Mutable plugin state — the one live dev handle (undefined = no live session; unicorn/no-null). */
export type State = { dev: DevHandle | undefined };

/** Public API of the tauri plugin — the framework's ONLY subprocess seam. */
export type Api = {
  icon(opts: { source: string }): Promise<RunResult>;
  build(opts: {
    target: Target;
    onTick?: (tick: CompileTick) => void;
    onOutput?: (line: string) => void;
  }): Promise<RunResult>;
  mobileInit(opts: { platform: "ios" | "android" }): Promise<RunResult>;
  dev(opts: { target?: Target; onOutput?: (line: string) => void }): Promise<DevHandle>;
  version(): Promise<{ cliVersion: string } | null>;
};

/**
 * Domain context shared by every tauri domain file. Structural composition
 * (not the bare `PluginCtx` export) because this plugin needs `global`
 * (projectDir, web.dev.url) and the `log`/`env` core APIs alongside
 * `config`/`state` — see moku-testing's mock-context.md §Standard Factory.
 */
export type TauriContext = {
  readonly global: Readonly<GlobalConfig>;
  readonly config: Readonly<Config>;
  state: State;
  readonly log: LogApi;
  readonly env: EnvApi;
};
