/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/SpawnFn result
   shapes (`signal: string | null`, `code: number | null`), which stay `| null` per spec/02's
   Node-mirroring reconciliation — not a lazy `null` fallback. */
import { describe, expect, it, vi } from "vitest";
import type { DevOrchestrationDeps } from "../../dev";
import { fetchReadinessProbe, startDev } from "../../dev";
import type { SpawnFn } from "../../types";

/** No-op placeholder for `resolveFn` before the Promise executor assigns the real resolver. */
function noop(): void {}

type DeferredSpawn = {
  spawn: SpawnFn;
  resolve: (result: {
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }) => void;
  calls: Array<{
    cmd: readonly string[];
    detached?: boolean | undefined;
    onLine?: ((line: string) => void) | undefined;
  }>;
};

function createDeferredSpawn(): DeferredSpawn {
  const calls: DeferredSpawn["calls"] = [];
  let resolveFn: DeferredSpawn["resolve"] = noop;
  const promise = new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>(resolve => {
    resolveFn = resolve;
  });
  const spawn: SpawnFn = opts => {
    calls.push({ cmd: opts.cmd, detached: opts.detached, onLine: opts.onLine });
    opts.signal?.addEventListener("abort", () => {
      resolveFn({ code: null, signal: "SIGTERM", stdout: "", stderr: "" });
    });
    return promise;
  };
  return { spawn, resolve: resolveFn, calls };
}

/** Spawn seam that fails outright (the `node` binary is gone / not executable). */
const spawnRejects: SpawnFn = async () => {
  throw new Error("spawn ENOENT");
};

/** Spawn seam for a dev process that dies on its own — a taken port, a config error. */
const spawnExitsImmediately: SpawnFn = async () => ({
  code: 1,
  signal: null,
  stdout: "",
  stderr: "port already in use"
});

function createDeps(overrides: Partial<DevOrchestrationDeps> = {}): DevOrchestrationDeps {
  return {
    spawn: overrides.spawn ?? createDeferredSpawn().spawn,
    probeReady: overrides.probeReady ?? vi.fn(async () => true),
    intervalMs: overrides.intervalMs ?? 1,
    timeoutMs: overrides.timeoutMs ?? 200,
    onSignal: overrides.onSignal ?? (() => {}),
    offSignal: overrides.offSignal ?? (() => {})
  };
}

describe("startDev", () => {
  it("returns immediately with a handle bound to the dev URL", () => {
    const handle = startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      deps: createDeps()
    });
    expect(handle.url).toBe("http://localhost:5173");
    expect(handle.ready).toBeInstanceOf(Promise);
    expect(handle.exited).toBeInstanceOf(Promise);
  });

  it("spawns the process detached (process-group semantics)", () => {
    const { spawn, calls } = createDeferredSpawn();
    startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      deps: createDeps({ spawn })
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.detached).toBe(true);
  });

  it("ready resolves once probeReady succeeds", async () => {
    let attempts = 0;
    const probeReady = vi.fn(async () => {
      attempts += 1;
      return attempts >= 2;
    });
    const handle = startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      deps: createDeps({ probeReady })
    });
    await expect(handle.ready).resolves.toBeUndefined();
    expect(probeReady).toHaveBeenCalledTimes(2);
  });

  it("installs SIGINT/SIGTERM handlers and removes them on exit", async () => {
    const onSignal = vi.fn();
    const offSignal = vi.fn();
    const { spawn, resolve } = createDeferredSpawn();
    const handle = startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      deps: createDeps({ spawn, onSignal, offSignal })
    });

    expect(onSignal).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onSignal).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

    resolve({ code: 0, signal: null, stdout: "", stderr: "" });
    await handle.exited;

    expect(offSignal).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(offSignal).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("stop() aborts the spawn signal and resolves exited; is idempotent", async () => {
    const { spawn } = createDeferredSpawn();
    const handle = startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      deps: createDeps({ spawn })
    });

    await handle.stop();
    await handle.stop();
    const exit = await handle.exited;
    expect(exit).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("a signal handler invocation stops the dev session", async () => {
    let sigintHandler: (() => void) | undefined;
    const onSignal = (event: NodeJS.Signals, handler: () => void) => {
      if (event === "SIGINT") sigintHandler = handler;
    };
    const { spawn } = createDeferredSpawn();
    const handle = startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      deps: createDeps({ spawn, onSignal })
    });

    sigintHandler?.();
    const exit = await handle.exited;
    expect(exit).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("forwards onLine into the spawn call so no dev output bypasses the caller's scrub pipeline", () => {
    const { spawn, calls } = createDeferredSpawn();
    const received: string[] = [];
    startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: line => received.push(line),
      deps: createDeps({ spawn })
    });

    expect(calls[0]?.onLine).toBeTypeOf("function");
    calls[0]?.onLine?.("Compiling app v0.1.0");
    expect(received).toEqual(["Compiling app v0.1.0"]);
  });

  it("stop() resolves even when the spawn itself rejected (teardown never rethrows)", async () => {
    const handle = startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      deps: createDeps({ spawn: spawnRejects })
    });
    handle.exited.catch(() => {
      // The session's failure is observed through `exited`, not through stop().
    });

    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("ready rejects as soon as stop() is requested, without waiting out the timeout", async () => {
    const { spawn } = createDeferredSpawn();
    const probeReady = vi.fn(async () => false);
    const handle = startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      // A timeout long enough that waiting it out would hang the suite.
      deps: createDeps({ spawn, probeReady, intervalMs: 1, timeoutMs: 600_000 })
    });

    await handle.stop();

    await expect(handle.ready).rejects.toThrow(
      /^\[native\] dev session stopped before the dev server became ready\./
    );
  });

  it("ready rejects when the dev process exits before the server is ready", async () => {
    const handle = startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      deps: createDeps({
        spawn: spawnExitsImmediately,
        probeReady: vi.fn(async () => false),
        intervalMs: 1,
        timeoutMs: 600_000
      })
    });

    await expect(handle.ready).rejects.toThrow(/dev session stopped before the dev server/);
    await expect(handle.exited).resolves.toEqual({ code: 1, signal: null });
  });

  it("readiness timeout rejects ready and reaps the process group", async () => {
    const { spawn } = createDeferredSpawn();
    const probeReady = vi.fn(async () => false);
    const handle = startDev({
      cmd: ["node", "tauri.js", "dev", "--ci"],
      cwd: "/proj",
      url: "http://localhost:5173",
      onLine: () => {},
      deps: createDeps({ spawn, probeReady, intervalMs: 5, timeoutMs: 20 })
    });

    await expect(handle.ready).rejects.toThrow(/did not become ready/);
    const exit = await handle.exited;
    expect(exit).toEqual({ code: null, signal: "SIGTERM" });
  });
});

describe("fetchReadinessProbe", () => {
  it("bounds every probe with an abort signal so a hung dev server cannot stall the poll", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    await expect(fetchReadinessProbe("http://localhost:5173")).resolves.toBe(true);

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    fetchSpy.mockRestore();
  });

  it("reports not-ready when the probe itself fails or times out", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(fetchReadinessProbe("http://localhost:5173")).resolves.toBe(false);
    fetchSpy.mockRestore();
  });
});
