/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/SpawnFn result
   shapes (`signal: string | null`, `code: number | null`), which stay `| null` per spec/02's
   Node-mirroring reconciliation — not a lazy `null` fallback. */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { TauriError } from "../../errors";
import { tauriPlugin } from "../../index";
import type { SpawnFn } from "../../types";

// Scoped harness: composes ONLY the tauri plugin (depends: []), so this test
// never depends on sibling plugins (project/build/doctor/cli) being implemented.
const framework = createCore(coreConfig, { plugins: [tauriPlugin] });
const createApp = framework.createApp;

const spawnBuildOutput: SpawnFn = async opts => {
  opts.onLine?.("[1/1] Compiling demo v0.1.0");
  return { code: 0, signal: null, stdout: "built", stderr: "" };
};

const spawnSigningFailure: SpawnFn = async () => ({
  code: 1,
  signal: null,
  stdout: "",
  stderr: "error: codesign failed: no identity found in keychain"
});

/**
 * The two simulator hosts, pinned so no assertion reads the real `process.arch`: Tauri
 * names the Intel simulator slice `x86_64` and every other one `<arch>-sim`.
 */
const SIMULATOR_HOSTS = [
  { arch: "arm64", rustTarget: "aarch64-sim" },
  { arch: "x64", rustTarget: "x86_64" }
] as const;

/** Fake dev-verb spawn: resolves with a synthetic SIGTERM exit once the caller aborts. */
const spawnAbortsToSigterm: SpawnFn = opts =>
  new Promise(resolve => {
    opts.signal?.addEventListener("abort", () => {
      resolve({ code: null, signal: "SIGTERM", stdout: "", stderr: "" });
    });
  });

describe("tauri plugin integration", () => {
  it("build() resolves a RunResult and forwards compile ticks", async () => {
    const app = createApp({
      pluginConfigs: { tauri: { spawnImpl: spawnBuildOutput, nodePath: "/usr/bin/node" } }
    });
    await app.start();

    const ticks: Array<{ crate: string }> = [];
    const result = await app.tauri.build({ target: "macos", onTick: tick => ticks.push(tick) });

    expect(result).toEqual({
      code: 0,
      stdout: "built",
      stderr: "",
      durationMs: expect.any(Number)
    });
    expect(ticks).toEqual([{ crate: "demo", index: 1, total: 1 }]);

    await app.stop();
  });

  it("build() throws a classified TauriError on a non-zero exit", async () => {
    const app = createApp({
      pluginConfigs: { tauri: { spawnImpl: spawnSigningFailure, nodePath: "/usr/bin/node" } }
    });
    await app.start();

    await expect(app.tauri.build({ target: "macos" })).rejects.toBeInstanceOf(TauriError);
    await expect(app.tauri.build({ target: "macos" })).rejects.toMatchObject({
      kind: "signing-failed"
    });

    await app.stop();
  });

  it.each(
    SIMULATOR_HOSTS
  )("build() carries the simulator option and the injected $arch arch through to the spawned argv", async ({
    arch,
    rustTarget
  }) => {
    const calls: Array<readonly string[]> = [];
    const spawnRecording: SpawnFn = async opts => {
      calls.push(opts.cmd);
      return { code: 0, signal: null, stdout: "built", stderr: "" };
    };
    const app = createApp({
      pluginConfigs: { tauri: { spawnImpl: spawnRecording, nodePath: "/usr/bin/node", arch } }
    });
    await app.start();

    await app.tauri.build({ target: "ios", simulator: true });

    expect(calls[0]?.slice(2)).toEqual(["ios", "build", "--ci", "--target", rustTarget]);

    await app.stop();
  });

  it("runner() exposes the same invocation prefix every verb spawns with", async () => {
    const calls: Array<readonly string[]> = [];
    const spawnRecording: SpawnFn = async opts => {
      calls.push(opts.cmd);
      return { code: 0, signal: null, stdout: "", stderr: "" };
    };
    const app = createApp({
      pluginConfigs: { tauri: { spawnImpl: spawnRecording, nodePath: "/usr/bin/node" } }
    });
    await app.start();

    await app.tauri.mobileInit({ target: "ios" });
    const runner = app.tauri.getRunner();

    expect([runner.nodePath, runner.tauriJsPath]).toEqual(calls[0]?.slice(0, 2));

    await app.stop();
  });

  it("dev() lifecycle: installs signal handlers, stop() group-kills and removes them", async () => {
    const onSignal = vi.fn();
    const offSignal = vi.fn();
    const originalOn = process.on.bind(process);
    const originalOff = process.off.bind(process);
    const onSpy = vi.spyOn(process, "on").mockImplementation((event, handler) => {
      onSignal(event, handler);
      return originalOn(event, handler);
    });
    const offSpy = vi.spyOn(process, "off").mockImplementation((event, handler) => {
      offSignal(event, handler);
      return originalOff(event, handler);
    });

    const app = createApp({
      pluginConfigs: {
        tauri: {
          spawnImpl: spawnAbortsToSigterm,
          nodePath: "/usr/bin/node",
          readiness: { intervalMs: 1, timeoutMs: 200 }
        }
      }
    });
    await app.start();

    const handle = await app.tauri.dev({ target: "macos" });
    handle.ready.catch(() => {
      // Readiness is irrelevant here — the probe targets a URL nothing serves.
    });
    expect(onSignal).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onSignal).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

    await handle.stop();
    const exit = await handle.exited;
    expect(exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(offSignal).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(offSignal).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

    onSpy.mockRestore();
    offSpy.mockRestore();
    await app.stop();
  });

  it("a second concurrent dev() throws [native] dev already running", async () => {
    const app = createApp({
      pluginConfigs: { tauri: { spawnImpl: spawnAbortsToSigterm, nodePath: "/usr/bin/node" } }
    });
    await app.start();

    const handle = await app.tauri.dev({ target: "macos" });
    handle.ready.catch(() => {
      // Readiness is irrelevant here — the probe targets a URL nothing serves.
    });
    await expect(app.tauri.dev({ target: "macos" })).rejects.toThrow(
      /\[native\] tauri dev already running/
    );

    await handle.stop();
    await app.stop();
  });

  it("respects readiness config overrides (short timeout rejects ready and reaps the group)", async () => {
    const app = createApp({
      pluginConfigs: {
        tauri: {
          spawnImpl: spawnAbortsToSigterm,
          nodePath: "/usr/bin/node",
          readiness: { intervalMs: 5, timeoutMs: 20 }
        }
      }
    });
    await app.start();

    const handle = await app.tauri.dev({ target: "macos" });
    await expect(handle.ready).rejects.toThrow(/did not become ready/);
    const exit = await handle.exited;
    expect(exit).toEqual({ code: null, signal: "SIGTERM" });

    await app.stop();
  });
});

describe("tauri plugin — type-level", () => {
  it("provides a typed DevHandle from app.tauri.dev", () => {
    const app = createApp();
    expectTypeOf(app.tauri.dev).returns.resolves.toExtend<{
      url: string;
      ready: Promise<void>;
      exited: Promise<{ code: number | null; signal: string | null }>;
      stop(): Promise<void>;
    }>();
  });

  it("rejects an invalid target at compile time", async () => {
    const app = createApp();
    // @ts-expect-error — "amiga" is not a valid Target
    await expect(app.tauri.build({ target: "amiga" })).rejects.toBeDefined();
  });
});
