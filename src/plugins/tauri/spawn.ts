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
  /**
   * Whether this spawn created its own process group (`detached: true`). Only then may a
   * signal be sent to the NEGATED pid: a child that is not a group leader shares its
   * parent's group, and `kill(-pid)` would either hit an unrelated group or fail with
   * ESRCH. Default true — the historical, detached-dev-session shape.
   */
  group?: boolean;
};

const DEFAULT_GRACE_MS = 2000;

/**
 * How long to wait after SIGKILL before reporting the process dead. SIGKILL is delivered
 * asynchronously and the kernel still has to reap the group, so resolving the instant the
 * signal is sent makes `stop()` lie about the process being gone.
 */
export const SIGKILL_SETTLE_MS = 250;

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
 * Kills a spawned process with an escalation ladder: POSIX sends SIGTERM, waits
 * `graceMs` for a natural exit, then escalates to SIGKILL and gives the kernel
 * {@link SIGKILL_SETTLE_MS} to reap it. The signal goes to the whole group (the
 * negated pid) only when this spawn created that group — a one-shot verb spawns
 * without `detached`, so its child shares the parent's group and is signalled by
 * pid. Windows has no group-signal concept and shells out to
 * `taskkill /PID <pid> /T /F` instead. Idempotent — resolves immediately when the
 * process has no pid or already exited.
 *
 * Every signal is best-effort: a process that exited between the check and the
 * signal raises ESRCH, which must never surface as a rejection — callers fire
 * this from an abort handler, where a rejection becomes an unhandled one.
 *
 * @param proc - The process (or fake) to terminate.
 * @param opts - Grace period, platform, group ownership, and injectable signal senders.
 * @returns A promise that resolves once the process is confirmed dead (or termination has settled).
 * @example
 * ```ts
 * await killProcessGroup(child, { graceMs: 2000, group: true });
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
    taskkill = defaultTaskkill,
    group = true
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

    // Negative = the whole process group; plain pid = this child alone.
    const signalTarget = group ? -pid : pid;

    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Marks the process as dead (natural exit or the SIGKILL settle window) and
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
      if (graceTimer) clearTimeout(graceTimer);
      resolve();
    };

    proc.onExit(finish);
    sendSignalQuietly(sendSignal, signalTarget, "SIGTERM");

    graceTimer = setTimeout(() => {
      if (settled) return;
      sendSignalQuietly(sendSignal, signalTarget, "SIGKILL");
      setTimeout(finish, SIGKILL_SETTLE_MS).unref();
    }, graceMs);
  });
}

/**
 * Sends one signal and swallows the failure. Termination is best-effort by
 * definition: the target may have exited a microsecond earlier (ESRCH) or never
 * have been ours to signal (EPERM), and neither is worth failing a teardown over.
 *
 * @param send - The signal sender to call.
 * @param pid - Target pid (negative = process group).
 * @param signal - Signal to send.
 * @example
 * ```ts
 * sendSignalQuietly(process.kill, -1234, "SIGTERM");
 * ```
 */
function sendSignalQuietly(send: SignalSender, pid: number, signal: NodeJS.Signals): void {
  try {
    send(pid, signal);
  } catch {
    // Already gone, or not ours — the ladder's next rung (or the exit listener) covers it.
  }
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

    // Group-signalling is only legitimate when THIS spawn made the child a group leader.
    const killOptions: GroupKillOptions = { group: opts.detached ?? false };
    if (opts.signal) {
      if (opts.signal.aborted) void killProcessGroup(fakeable, killOptions);
      else
        opts.signal.addEventListener("abort", () => void killProcessGroup(fakeable, killOptions));
    }

    child.on("error", reject);
    // Two distinct events on purpose: `exit` is when the process is gone — the
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
