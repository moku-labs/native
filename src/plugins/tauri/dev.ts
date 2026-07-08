/**
 * @file tauri plugin — dev orchestration: spawn, signal handlers, devUrl readiness poll.
 *
 * NO stdout "ready" marker exists (tauri#4740) — devUrl polling is the only
 * dependable readiness signal. This is a one-shot (spawn once) but long-running
 * (never awaited to completion by the caller) calling convention, distinct from
 * the one-shot verbs in api.ts.
 */
import type { DevExit, DevHandle, SpawnFn } from "./types";

/** Probes whether the dev URL is responding yet. Injectable — the real one is `fetchReadinessProbe`. */
export type ReadinessProbe = (url: string) => Promise<boolean>;

/** Dependencies {@link startDev} needs, all injectable for tests. */
export type DevOrchestrationDeps = {
  spawn: SpawnFn;
  probeReady: ReadinessProbe;
  intervalMs: number;
  timeoutMs: number;
  onSignal: (event: NodeJS.Signals, handler: () => void) => void;
  offSignal: (event: NodeJS.Signals, handler: () => void) => void;
  /** Clock override for deterministic timeout tests. Defaults to `Date.now`. */
  now?: () => number;
};

/** Options for {@link startDev}. */
export type StartDevOptions = {
  cmd: readonly string[];
  cwd: string;
  url: string;
  /** Receives every raw output line from the dev process — the caller (api.ts) owns scrubbing + display routing. Required so no dev output path can bypass the scrub pipeline. */
  onLine: (line: string) => void;
  deps: DevOrchestrationDeps;
};

/**
 * Default readiness probe — resolves `true` as soon as `fetch(url)` settles
 * (any response, even non-2xx, means the dev server is up); `false` on a
 * network-level failure (connection refused, DNS, etc.).
 *
 * @param url - The dev URL to probe.
 * @returns Whether the dev server responded.
 * @example
 * ```ts
 * await fetchReadinessProbe("http://localhost:5173");
 * ```
 */
export const fetchReadinessProbe: ReadinessProbe = async url => {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
};

/**
 * Starts a long-lived dev session: spawns the process group (detached),
 * installs SIGINT/SIGTERM handlers that group-kill and remove themselves on
 * exit, and polls `url` for readiness. A readiness timeout rejects `ready`
 * AND reaps the process group (`stop()`) — the CLI never signals readiness itself.
 *
 * @param opts - The argv/cwd/url and injectable orchestration dependencies.
 * @returns The live {@link DevHandle} — returns immediately, never awaits `exited`.
 * @example
 * ```ts
 * const handle = startDev({ cmd, cwd, url, deps });
 * await handle.ready;
 * ```
 */
export function startDev(opts: StartDevOptions): DevHandle {
  const controller = new AbortController();
  let stopRequested = false;

  const exitedPromise: Promise<DevExit> = opts.deps
    .spawn({
      cmd: opts.cmd,
      cwd: opts.cwd,
      detached: true,
      onLine: opts.onLine,
      signal: controller.signal
    })
    .then((result): DevExit => ({ code: result.code, signal: result.signal }));

  /**
   * SIGINT/SIGTERM handler — stops the dev session (group-kill) the same way
   * an explicit `handle.stop()` call would.
   *
   * @example
   * ```ts
   * process.on("SIGINT", handleSignal);
   * ```
   */
  const handleSignal = (): void => {
    stop().catch(() => {
      // stop() never rejects — this guards against a future refactor regressing that.
    });
  };
  opts.deps.onSignal("SIGINT", handleSignal);
  opts.deps.onSignal("SIGTERM", handleSignal);

  const exited = exitedPromise.finally(() => {
    opts.deps.offSignal("SIGINT", handleSignal);
    opts.deps.offSignal("SIGTERM", handleSignal);
  });

  /**
   * Stops the dev session: aborts the spawn signal (real impl group-kills)
   * and waits for the process group to exit. Idempotent.
   *
   * @returns Resolves once the process group has exited.
   * @example
   * ```ts
   * await handle.stop();
   * ```
   */
  async function stop(): Promise<void> {
    if (!stopRequested) {
      stopRequested = true;
      controller.abort();
    }
    await exited;
  }

  const ready = pollUntilReady(opts.url, opts.deps).catch(async (error: unknown) => {
    await stop();
    throw error;
  });

  return { url: opts.url, ready, exited, stop };
}

/**
 * Polls `url` until the readiness probe succeeds or `deps.timeoutMs` elapses.
 *
 * @param url - The dev URL to poll.
 * @param deps - Orchestration dependencies (probe, interval/timeout, clock).
 * @returns Resolves once the probe succeeds.
 * @throws {Error} `[native]` when the timeout elapses before readiness.
 * @example
 * ```ts
 * await pollUntilReady("http://localhost:5173", deps);
 * ```
 */
async function pollUntilReady(url: string, deps: DevOrchestrationDeps): Promise<void> {
  const clock = deps.now ?? Date.now;
  const deadline = clock() + deps.timeoutMs;
  for (;;) {
    if (await deps.probeReady(url)) return;
    if (clock() >= deadline) {
      throw new Error(
        `[native] dev server at ${url} did not become ready within ${deps.timeoutMs}ms.\n` +
          "  Check the dev server logs; the process group has been terminated."
      );
    }
    await delay(deps.intervalMs);
  }
}

/**
 * Resolves after `ms` milliseconds — the readiness poll's tick interval.
 *
 * @param ms - Milliseconds to wait.
 * @returns Resolves after the delay.
 * @example
 * ```ts
 * await delay(250);
 * ```
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
