/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/SpawnFn result
   shapes (`signal: string | null`, `code: number | null`), which stay `| null` per spec/02's
   Node-mirroring reconciliation — not a lazy `null` fallback. */
/* eslint-disable sonarjs/no-hardcoded-passwords -- the dev-output scrub test feeds a fake
   secret through the pipeline ON PURPOSE and asserts it comes out masked (same posture as
   scrub.test.ts). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTauriApi } from "../../api";
import { TauriError } from "../../errors";
import type { SpawnFn, State, TauriContext } from "../../types";

function createMockCtx(overrides?: Partial<TauriContext>): TauriContext {
  const state: State = overrides?.state ?? { dev: undefined };
  return {
    // tauri declares no events of its own; the seam exists because every plugin ctx carries it.
    emit: overrides?.emit ?? vi.fn(),
    global: {
      app: { name: "MyApp", identifier: "com.example.myapp" },
      web: {
        build: "bun run build",
        devCommand: "bun run dev",
        devUrl: "http://localhost:5173",
        dist: "dist"
      },
      system: [],
      capabilities: {},
      targets: ["macos", "windows", "linux", "ios", "android"],
      projectDir: "/proj/.moku/tauri",
      outDir: "dist-native",
      signing: {},
      ...overrides?.global
    },
    config: {
      spawnImpl: undefined,
      nodePath: "/usr/bin/node",
      readiness: { intervalMs: 1, timeoutMs: 50 },
      ...overrides?.config
    },
    state,
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(() => []),
      expect: vi.fn(),
      addSink: vi.fn(),
      reset: vi.fn(),
      clearSinks: vi.fn(),
      ...overrides?.log
    },
    env: {
      get: vi.fn(() => undefined),
      require: vi.fn((key: string) => key),
      has: vi.fn(() => false),
      getPublic: vi.fn(() => ({})),
      getPublicMap: vi.fn(() => new Map()),
      ...overrides?.env
    }
  };
}

function fakeSpawnResolving(result: {
  code: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}): SpawnFn {
  return async opts => {
    opts.onLine?.("Compiling demo v0.1.0");
    return {
      code: result.code,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  };
}

const spawnBuildForwardsOutput: SpawnFn = async opts => {
  opts.onLine?.("[1/2] Compiling foo v1.0.0");
  opts.onLine?.("[2/2] Compiling bar v1.0.0");
  return { code: 0, signal: null, stdout: "done", stderr: "" };
};

/** Long-lived dev spawn: exits only when the handle's group-kill aborts it. */
const spawnDevUntilAborted: SpawnFn = opts =>
  new Promise(resolve => {
    opts.signal?.addEventListener("abort", () => {
      resolve({ code: null, signal: "SIGTERM", stdout: "", stderr: "" });
    });
  });

const spawnCompileFailure: SpawnFn = async () => ({
  code: 101,
  signal: null,
  stdout: "",
  stderr: "error[E0432]: unresolved import `foo`"
});

// xcodebuild writes the real cause to STDOUT; stderr carries only tauri's one-line wrapper.
const spawnXcodeScriptFailure: SpawnFn = async () => ({
  code: 65,
  signal: null,
  stdout: [
    "** BUILD FAILED **",
    "The following build commands failed:",
    String.raw`	PhaseScriptExecution Build\ Rust\ Code /Users/x/Library/Developer/Xcode/DerivedData/app/Build/Script-80C98B.sh (in target 'app_iOS' from project 'app')`
  ].join("\n"),
  stderr:
    'failed to build iOS app: failed to build with xcodebuild: command ["xcodebuild"] exited with code 65'
});

const spawnVersionOutput: SpawnFn = async () => ({
  code: 0,
  signal: null,
  stdout: "tauri-cli: 2.11.4\nother info",
  stderr: ""
});

const spawnUnavailable: SpawnFn = async () => {
  throw new Error("ENOENT");
};

type SpawnRecorder = { spawn: SpawnFn; calls: Array<{ cmd: readonly string[]; cwd: string }> };

function createSpawnRecorder(): SpawnRecorder {
  const calls: SpawnRecorder["calls"] = [];
  const spawn: SpawnFn = async opts => {
    calls.push({ cmd: opts.cmd, cwd: opts.cwd });
    return { code: 0, signal: null, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

describe("createTauriApi", () => {
  it("icon() resolves a RunResult on a zero exit", async () => {
    const spawnImpl = fakeSpawnResolving({ code: 0, stdout: "ok" });
    const ctx = createMockCtx({
      config: { spawnImpl, nodePath: "/usr/bin/node", readiness: { intervalMs: 1, timeoutMs: 50 } }
    });
    const api = createTauriApi(ctx);

    const result = await api.icon({ source: "icon.png" });
    expect(result).toEqual({ code: 0, stdout: "ok", stderr: "", durationMs: expect.any(Number) });
  });

  it("build() forwards parsed compile ticks and scrubbed output lines", async () => {
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawnBuildForwardsOutput,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    const ticks: Array<{ crate: string; index?: number; total?: number }> = [];
    const lines: string[] = [];
    await api.build({
      target: "macos",
      onTick: tick => ticks.push(tick),
      onOutput: line => lines.push(line)
    });

    expect(ticks).toEqual([
      { crate: "foo", index: 1, total: 2 },
      { crate: "bar", index: 2, total: 2 }
    ]);
    expect(lines).toEqual(["[1/2] Compiling foo v1.0.0", "[2/2] Compiling bar v1.0.0"]);
  });

  it("build() throws a classified TauriError on a non-zero exit", async () => {
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawnCompileFailure,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    await expect(api.build({ target: "macos" })).rejects.toBeInstanceOf(TauriError);
    await expect(api.build({ target: "macos" })).rejects.toMatchObject({ kind: "compile-failed" });
  });

  it("build() classifies on stdout too — xcodebuild writes the cause there", async () => {
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawnXcodeScriptFailure,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    await expect(api.build({ target: "ios" })).rejects.toMatchObject({
      kind: "xcode-script-failed"
    });
    await expect(api.build({ target: "ios" })).rejects.toMatchObject({
      stderrTail: expect.stringContaining("PhaseScriptExecution")
    });
  });

  it("icon() targets the generated project's src-tauri/icons directory", async () => {
    const { spawn, calls } = createSpawnRecorder();
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawn,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    await api.icon({ source: "assets/icon.png" });

    expect(calls[0]?.cmd.slice(2)).toEqual([
      "icon",
      "assets/icon.png",
      "--output",
      path.resolve("/proj/.moku/tauri", "src-tauri", "icons")
    ]);
  });

  it("build() forwards simulator and export-method options into the argv", async () => {
    const { spawn, calls } = createSpawnRecorder();
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawn,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    await api.build({ target: "ios", exportMethod: "release-testing" });
    await api.build({ target: "android", aab: true });

    expect(calls[0]?.cmd.slice(2)).toEqual([
      "ios",
      "build",
      "--ci",
      "--export-method",
      "release-testing"
    ]);
    expect(calls[1]?.cmd.slice(2)).toEqual(["android", "build", "--ci", "--aab"]);
  });

  it("run() falls back to process.cwd() when projectDir does not exist yet", async () => {
    const { spawn, calls } = createSpawnRecorder();
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawn,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    await api.icon({ source: "icon.png" });

    expect(calls[0]?.cwd).toBe(process.cwd());
  });

  it("run() uses projectDir once it exists", async () => {
    // Fresh temp dir — never the repo, never cwd; nothing here deletes it.
    const projectDir = mkdtempSync(path.join(tmpdir(), "moku-native-tauri-cwd-"));
    const { spawn, calls } = createSpawnRecorder();
    const ctx = createMockCtx({
      global: { ...createMockCtx().global, projectDir },
      config: {
        spawnImpl: spawn,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    await api.icon({ source: "icon.png" });

    expect(calls[0]?.cwd).toBe(projectDir);
  });

  it("runner() exposes the resolved node + tauri.js invocation prefix", () => {
    const ctx = createMockCtx();
    const api = createTauriApi(ctx);

    const runner = api.getRunner();

    expect(runner.nodePath).toBe("/usr/bin/node");
    expect(runner.tauriJsPath).toMatch(/@tauri-apps[/\\]cli[/\\]tauri\.js$/);
  });

  it("mobileInit() resolves a RunResult", async () => {
    const spawnImpl = fakeSpawnResolving({ code: 0, stdout: "initialized" });
    const ctx = createMockCtx({
      config: { spawnImpl, nodePath: "/usr/bin/node", readiness: { intervalMs: 1, timeoutMs: 50 } }
    });
    const api = createTauriApi(ctx);

    const result = await api.mobileInit({ target: "ios" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("initialized");
  });

  it("mobileInit() spawns the per-target init verb", async () => {
    const { spawn, calls } = createSpawnRecorder();
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawn,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    await api.mobileInit({ target: "android" });

    expect(calls[0]?.cmd.slice(2)).toEqual(["android", "init", "--ci"]);
  });

  it("version() parses the CLI version from `tauri info` output", async () => {
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawnVersionOutput,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    await expect(api.getVersion()).resolves.toEqual({ cliVersion: "2.11.4" });
  });

  it("getVersion() returns undefined when the CLI can't be invoked", async () => {
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawnUnavailable,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    await expect(api.getVersion()).resolves.toBeUndefined();
  });

  it("dev() scrubs every output line before it reaches onOutput or the log", async () => {
    let emitLine: ((line: string) => void) | undefined;
    const devSpawn: SpawnFn = opts => {
      emitLine = opts.onLine;
      return new Promise(resolve => {
        // Long-lived dev process — exits only when the handle's group-kill aborts it.
        opts.signal?.addEventListener("abort", () => {
          resolve({ code: null, signal: "SIGTERM", stdout: "", stderr: "" });
        });
      });
    };
    const ctx = createMockCtx({
      config: {
        spawnImpl: devSpawn,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 50 }
      }
    });
    const api = createTauriApi(ctx);

    const lines: string[] = [];
    const handle = await api.dev({ onOutput: line => lines.push(line) });
    handle.ready.catch(() => {
      // Readiness is irrelevant here — the probe targets a URL nothing serves.
    });
    emitLine?.("APPLE_PASSWORD=hunter2 signing started");

    expect(lines).toEqual(["APPLE_PASSWORD=[native:scrubbed] signing started"]);
    expect(lines[0]).not.toContain("hunter2");
    expect(ctx.log.debug).toHaveBeenCalledWith("tauri:dev:output", {
      line: "APPLE_PASSWORD=[native:scrubbed] signing started"
    });

    await handle.stop();
  });

  it("dev() parks the ready rejection — a caller that only awaits exited sees no crash", async () => {
    const ctx = createMockCtx({
      config: {
        spawnImpl: spawnDevUntilAborted,
        nodePath: "/usr/bin/node",
        readiness: { intervalMs: 1, timeoutMs: 5 }
      }
    });
    const api = createTauriApi(ctx);

    // No `.catch` on `handle.ready` here on purpose: the readiness poll times out against a
    // URL nothing serves, and an unparked rejection would fail this file.
    const handle = await api.dev({});
    await expect(handle.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
  });

  it("dev() throws when a dev session is already running", async () => {
    const ctx = createMockCtx({
      state: {
        dev: {
          url: "http://localhost:5173",
          ready: Promise.resolve(),
          exited: Promise.resolve({ code: 0, signal: null }),
          stop: async () => {}
        }
      }
    });
    const api = createTauriApi(ctx);

    await expect(api.dev({})).rejects.toThrow(/\[native\] tauri dev already running/);
  });
});
