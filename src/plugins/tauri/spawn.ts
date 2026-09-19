/**
 * @file tauri plugin — real subprocess spawn (process-group) + group-kill escalation.
 *
 * `realSpawn` is the ONLY place in this framework that opens a real OS process
 * (D-013 invocation shape: `[nodePath, tauriJsPath, verb, ...args]`). Every
 * other call site goes through the injectable `SpawnFn` seam.
 */
import { execFile, spawn as spawnChildProcess } from "node:child_process";
import { splitLines } from "./stream";
import type { SpawnFn } from "./types";

/** Structural view of a live process — the minimal shape {@link killProcessGroup} needs. */
export type FakeableProcess = {
  readonly pid: number | undefined;
  readonly exited: boolean;
  onExit(listener: () => void): void;
};

/** Sends a signal to a pid (negative pid = POSIX process group). Injectable for tests. */
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void;

/** Options for {@link killProcessGroup}. */
export type GroupKillOptions = {
  /** Grace period between SIGTERM and the SIGKILL escalation. Default 2000ms. */
  graceMs?: number;
  /** `process.platform`-shaped value — injectable for cross-platform tests. */
  platform?: NodeJS.Platform;
  /** POSIX signal sender — injectable for tests (defaults to a real `process.kill` wrapper). */
  sendSignal?: SignalSender;
  /** Windows termination — injectable for tests (defaults to a real `taskkill` invocation). */
  taskkill?: (pid: number) => void;
};

const DEFAULT_GRACE_MS = 2000;

/**
 * Cap on the buffered stdout/stderr kept for the final result (per stream).
 * One-shot verbs stay far under it; a long-lived `dev` session (hours of
 * compiler/dev-server output) would otherwise grow unbounded — live output is
 * consumed line-by-line via `onLine`, so only the TAIL matters for the result
 * (same posture as errors.ts's stderr tail).
 */
export const MAX_BUFFERED_STREAM_CHARS = 262_144;

/**
 * Appends `text` to `existing`, keeping only the last {@link MAX_BUFFERED_STREAM_CHARS}
 * characters — a bounded tail buffer for long-lived spawns.
 *
 * @param existing - The buffered stream content so far.
 * @param text - The newly received chunk.
 * @returns The bounded combined buffer.
 * @example
 * ```ts
 * stdout = appendBounded(stdout, chunk.toString("utf8"));
 * ```
 */
function appendBounded(existing: string, text: string): string {
  const combined = existing + text;
  if (combined.length <= MAX_BUFFERED_STREAM_CHARS) return combined;
  return combined.slice(-MAX_BUFFERED_STREAM_CHARS);
}

/**
 * Kills a process group with an escalation ladder: POSIX sends SIGTERM to the
 * negated pid (the whole group), waits `graceMs` for a natural exit, then
 * escalates to SIGKILL. Windows has no group-signal concept, so it shells out
 * to `taskkill /PID <pid> /T /F` instead. Idempotent — resolves immediately
 * when the process has no pid or already exited.
 *
 * @param proc - The process (or fake) to terminate.
 * @param opts - Grace period, platform, and injectable signal senders.
 * @returns A promise that resolves once the group is confirmed dead (or termination was requested).
 * @example
 * ```ts
 * await killProcessGroup(child, { graceMs: 2000 });
 * ```
 */
export function killProcessGroup(
  proc: FakeableProcess,
  opts: GroupKillOptions = {}
): Promise<void> {
  const {
    graceMs = DEFAULT_GRACE_MS,
    platform = process.platform,
    sendSignal = defaultSendSignal,
    taskkill = defaultTaskkill
  } = opts;

  return new Promise(resolve => {
    if (proc.pid === undefined || proc.exited) {
      resolve();
      return;
    }
    const pid = proc.pid;

    if (platform === "win32") {
      taskkill(pid);
      resolve();
      return;
    }

    let settled = false;
    /**
     * Marks the group as dead (natural exit or SIGKILL escalation) and
     * resolves the outer promise exactly once.
     *
     * @example
     * ```ts
     * proc.onExit(finish);
     * ```
     */
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    proc.onExit(finish);
    sendSignal(-pid, "SIGTERM");

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sendSignal(-pid, "SIGKILL");
      resolve();
    }, graceMs);
  });
}

/**
 * Real POSIX signal sender — `process.kill(pid, signal)`.
 *
 * @param pid - Target pid (negative = process group).
 * @param signal - Signal to send.
 * @example
 * ```ts
 * defaultSendSignal(-1234, "SIGTERM");
 * ```
 */
function defaultSendSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

/**
 * Real Windows termination — shells out to `taskkill /PID <pid> /T /F`.
 *
 * @param pid - Target pid.
 * @example
 * ```ts
 * defaultTaskkill(1234);
 * ```
 */
function defaultTaskkill(pid: number): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- stock Windows system utility, not user input.
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

/**
 * Returns the parent process's environment — the base the spawned tauri CLI
 * subprocess inherits (PATH, cargo/toolchain vars, signing overrides).
 *
 * @returns The parent environment.
 * @example
 * ```ts
 * const environment = inheritedEnvironment();
 * ```
 */
function inheritedEnvironment(): NodeJS.ProcessEnv {
  return process.env; // @env-allow — passthrough: subprocess needs the parent environment
}

/**
 * Real `SpawnFn` implementation — spawns a detached process (group leader on
 * POSIX), streams stdout/stderr line-by-line to `onLine`, and resolves with the
 * full buffered output once the process's stdio has closed (`close`, not `exit`).
 * Honors `opts.signal` by group-killing the spawned process on abort.
 *
 * @param opts - Spawn options (cmd, cwd, env, detached, onLine, signal).
 * @returns The process result once it exits.
 * @example
 * ```ts
 * const result = await realSpawn({ cmd: [nodePath, tauriJsPath, "info"], cwd: projectDir });
 * ```
 */
export const realSpawn: SpawnFn = opts =>
  new Promise((resolve, reject) => {
    const [command, ...arguments_] = opts.cmd;
    if (!command) {
      reject(
        new Error(
          "[native] Cannot spawn an empty argv.\n  This is a tauri plugin bug — please report it."
        )
      );
      return;
    }

    const parentEnvironment = inheritedEnvironment();
    const child = spawnChildProcess(command, arguments_, {
      cwd: opts.cwd,
      env: opts.env ? { ...parentEnvironment, ...opts.env } : parentEnvironment,
      detached: opts.detached ?? false
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = appendBounded(stdout, text);
      const split = splitLines(stdoutBuffer, text);
      stdoutBuffer = split.buffer;
      for (const line of split.lines) opts.onLine?.(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = appendBounded(stderr, text);
      const split = splitLines(stderrBuffer, text);
      stderrBuffer = split.buffer;
      for (const line of split.lines) opts.onLine?.(line);
    });

    let hasExited = false;
    const fakeable: FakeableProcess = {
      /**
       * The real child process's pid.
       *
       * @returns The pid, or `undefined` before spawn assigns one.
       */
      get pid() {
        return child.pid;
      },
      /**
       * Whether the child process has already exited.
       *
       * @returns `true` once the `"exit"` event has fired.
       */
      get exited() {
        return hasExited;
      },
      /**
       * Registers a one-time listener for the child process's `"exit"` event.
       *
       * @param listener - Called once when the process exits.
       * @example
       * ```ts
       * fakeable.onExit(() => {});
       * ```
       */
      onExit(listener) {
        child.once("exit", listener);
      }
    };

    if (opts.signal) {
      if (opts.signal.aborted) void killProcessGroup(fakeable);
      else opts.signal.addEventListener("abort", () => void killProcessGroup(fakeable));
    }

    child.on("error", reject);
    // Two distinct events on purpose (M5): `exit` is when the process is gone — the
    // group-kill ladder must see that immediately — while `close` is when its stdio
    // pipes are drained. tauri's own children (xcodebuild, gradle, cargo) inherit
    // those pipes, so output still arrives AFTER `exit`; resolving there would drop
    // exactly the tail an error message is made of.
    child.on("exit", () => {
      hasExited = true;
    });
    child.on("close", (code, signal) => {
      hasExited = true;
      resolve({ code, signal, stdout, stderr });
    });
  });
