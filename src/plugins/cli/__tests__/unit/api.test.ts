/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/DevExit shapes
   (`signal: string | null`, `code: number | null`), which stay `| null` per spec/02's
   Node-mirroring reconciliation (matches build/doctor/tauri's own tests). */
import { describe, expect, it, vi } from "vitest";
import type { Target } from "../../../../config";
import { createCliApi, hostTarget } from "../../api";
import type { CliContext } from "../../types";

/** Minimal fixture-valid global config, shared by every mock ctx below (never touches disk). */
const validGlobalConfig = {
  app: { name: "Test App", identifier: "com.example.testapp" },
  web: {
    build: "bun run build",
    devCommand: "bun run dev",
    devUrl: "http://localhost:5173",
    dist: "dist"
  },
  system: [],
  capabilities: {},
  targets: ["macos"] as readonly Target[],
  projectDir: "/unused",
  outDir: "/unused",
  signing: {}
};

/** Fresh fakes for every one of cli's four required plugin APIs. */
function createMocks() {
  return {
    project: { clean: vi.fn().mockResolvedValue({ removed: [] }) },
    tauri: {
      dev: vi.fn().mockResolvedValue({
        url: "http://localhost:1420",
        ready: Promise.resolve(),
        exited: Promise.resolve({ code: 0, signal: null }),
        stop: vi.fn().mockResolvedValue(undefined)
      })
    },
    build: {
      run: vi.fn().mockResolvedValue({
        target: "macos",
        outPath: "x",
        artifacts: [],
        durationMs: 1,
        phases: []
      }),
      runAll: vi.fn().mockResolvedValue([])
    },
    doctor: { run: vi.fn().mockResolvedValue({ ok: true, checks: [] }) }
  };
}

type Mocks = ReturnType<typeof createMocks>;

/** Builds a mock `CliContext` whose `require` resolves to the given (or fresh) mocks. */
function createMockCtx(overrides?: {
  mocks?: Mocks;
  renderImpl?: (line: string) => void;
  confirmImpl?: (question: string) => Promise<boolean>;
}): { ctx: CliContext; mocks: Mocks } {
  const mocks = overrides?.mocks ?? createMocks();
  const requireFn = vi.fn((plugin: { name: string }) => {
    switch (plugin.name) {
      case "project": {
        return mocks.project;
      }
      case "tauri": {
        return mocks.tauri;
      }
      case "build": {
        return mocks.build;
      }
      case "doctor": {
        return mocks.doctor;
      }
      default: {
        throw new Error(`unexpected require: ${plugin.name}`);
      }
    }
  });

  const ctx: CliContext = {
    global: validGlobalConfig,
    config: { renderImpl: overrides?.renderImpl, confirmImpl: overrides?.confirmImpl },
    state: { progress: { phase: undefined, startedAt: undefined, ticks: 0 } },
    require: requireFn as CliContext["require"]
  };

  return { ctx, mocks };
}

describe("hostTarget", () => {
  it.each([
    ["darwin", "macos"],
    ["win32", "windows"],
    ["linux", "linux"]
  ] as const)("maps host platform %s to target %s", (platform, expected) => {
    expect(hostTarget(platform)).toBe(expected);
  });

  it("throws a [native] error for an unsupported host platform", () => {
    expect(() => hostTarget("freebsd")).toThrow(/^\[native\] No default packaging target/);
  });
});

describe("createCliApi — build", () => {
  it("{ all: true } calls runAll and ignores an explicit target", async () => {
    const { ctx, mocks } = createMockCtx();
    const api = createCliApi(ctx);

    await api.build({ all: true, target: "android" });

    expect(mocks.build.runAll).toHaveBeenCalledOnce();
    expect(mocks.build.run).not.toHaveBeenCalled();
  });

  it("uses the explicit target when given", async () => {
    const { ctx, mocks } = createMockCtx();
    const api = createCliApi(ctx);

    await api.build({ target: "android" });

    expect(mocks.build.run).toHaveBeenCalledWith({ target: "android" });
  });

  it("falls back to the resolved host target when omitted", async () => {
    const { ctx, mocks } = createMockCtx();
    const api = createCliApi(ctx);

    await api.build();

    expect(mocks.build.run).toHaveBeenCalledWith({ target: hostTarget() });
  });
});

describe("createCliApi — dev", () => {
  it("forwards scrubbed dev output through the render seam and never calls stop", async () => {
    const lines: string[] = [];
    const stop = vi.fn().mockResolvedValue(undefined);
    const mocks = createMocks();
    mocks.tauri.dev = vi.fn(async (opts: { onOutput?: (line: string) => void }) => {
      opts.onOutput?.("Compiling app v0.1.0");
      return {
        url: "http://localhost:1420",
        ready: Promise.resolve(),
        exited: Promise.resolve({ code: 0, signal: null }),
        stop
      };
    });
    const { ctx } = createMockCtx({
      mocks,
      renderImpl: line => {
        lines.push(line);
      }
    });
    const api = createCliApi(ctx);

    await api.dev();

    expect(lines.some(line => line.includes("Compiling app v0.1.0"))).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects when the dev handle exits with a non-zero code", async () => {
    const mocks = createMocks();
    mocks.tauri.dev = vi.fn().mockResolvedValue({
      url: "http://localhost:1420",
      ready: Promise.resolve(),
      exited: Promise.resolve({ code: 1, signal: null }),
      stop: vi.fn()
    });
    const { ctx } = createMockCtx({ mocks });
    const api = createCliApi(ctx);

    await expect(api.dev()).rejects.toThrow(/tauri dev exited with code 1/);
  });

  it("resolves cleanly on a signal-terminated exit (Ctrl-C → code null, D-002)", async () => {
    const mocks = createMocks();
    mocks.tauri.dev = vi.fn().mockResolvedValue({
      url: "http://localhost:1420",
      ready: Promise.resolve(),
      exited: Promise.resolve({ code: null, signal: "SIGTERM" }),
      stop: vi.fn()
    });
    const { ctx } = createMockCtx({ mocks });
    const api = createCliApi(ctx);

    await expect(api.dev()).resolves.toBeUndefined();
  });
});

describe("createCliApi — doctor", () => {
  it("returns report.ok and renders the summary", async () => {
    const mocks = createMocks();
    mocks.doctor.run = vi.fn().mockResolvedValue({
      ok: false,
      checks: [{ id: "x", target: "host", status: "fail", message: "boom" }]
    });
    const lines: string[] = [];
    const { ctx } = createMockCtx({
      mocks,
      renderImpl: line => {
        lines.push(line);
      }
    });
    const api = createCliApi(ctx);

    const ok = await api.doctor();

    expect(ok).toBe(false);
    expect(mocks.doctor.run).toHaveBeenCalledWith({});
    expect(lines.join("\n")).toContain("boom");
  });

  it("forwards an explicit target", async () => {
    const { ctx, mocks } = createMockCtx();
    const api = createCliApi(ctx);

    await api.doctor({ target: "ios" });

    expect(mocks.doctor.run).toHaveBeenCalledWith({ target: "ios" });
  });
});

describe("createCliApi — clean", () => {
  it("without a target: aborts without cleaning when confirm resolves false", async () => {
    const confirmImpl = vi.fn().mockResolvedValue(false);
    const { ctx, mocks } = createMockCtx({ confirmImpl });
    const api = createCliApi(ctx);

    await api.clean();

    expect(confirmImpl).toHaveBeenCalledOnce();
    expect(mocks.project.clean).not.toHaveBeenCalled();
  });

  it("without a target: delegates to project.clean when confirm resolves true", async () => {
    const confirmImpl = vi.fn().mockResolvedValue(true);
    const { ctx, mocks } = createMockCtx({ confirmImpl });
    const api = createCliApi(ctx);

    await api.clean();

    expect(mocks.project.clean).toHaveBeenCalledWith({});
  });

  it("with a target: skips confirm and delegates directly", async () => {
    const confirmImpl = vi.fn();
    const { ctx, mocks } = createMockCtx({ confirmImpl });
    const api = createCliApi(ctx);

    await api.clean({ target: "android" });

    expect(confirmImpl).not.toHaveBeenCalled();
    expect(mocks.project.clean).toHaveBeenCalledWith({ target: "android" });
  });
});
