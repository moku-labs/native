/**
 * @file tauri plugin — type definitions (structural — never runtime-package namespace types).
 */
import type { Target } from "../../config";

/** Structural spawn seam — injectable for tests (skeleton-conventions §3). */
export type SpawnFn = (opts: {
  cmd: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  detached?: boolean;
  onLine?: (line: string) => void;
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
  dev(opts: { target?: Target }): Promise<DevHandle>;
  version(): Promise<{ cliVersion: string } | null>;
};
