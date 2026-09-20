/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/DevExit shapes
   (`signal: string | null`, `code: number | null`), which stay `| null` per spec/02's
   Node-mirroring reconciliation (matches build/doctor/tauri's own tests). */
import { describe, expect, it, vi } from "vitest";
import { TauriError } from "../../../tauri/errors";
import { createCliApi, hostTarget } from "../../api";
import { createCliState } from "../../state";
import type { CliContext, CliDeps, Config } from "../../types";

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
  targets: ["macos"],
  projectDir: "/unused",
  outDir: "/unused",
  signing: {}
} satisfies CliContext["global"];

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
      prepare: vi.fn().mockResolvedValue(undefined),
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

/** Builds a mock `CliContext` plus the `CliDeps` the verbs delegate to. */
function createMockCtx(overrides?: {
  mocks?: Mocks;
  renderImpl?: (line: string) => void;
  confirmImpl?: (question: string) => Promise<boolean>;
}): { ctx: CliContext; deps: CliDeps; mocks: Mocks } {
  const mocks = overrides?.mocks ?? createMocks();

  const config: Config = {
    renderImpl: overrides?.renderImpl,
    confirmImpl: overrides?.confirmImpl
  };

  const ctx: CliContext = {
    global: validGlobalConfig,
    config,
    // The real state factory — the branded console is created ONCE there.
    state: createCliState({ global: validGlobalConfig, config }),
    // cli emits nothing of its own; the seam exists on every plugin ctx.
    emit: vi.fn()
  };

  return { ctx, deps: mocks, mocks };
}

describe("hostTarget", () => {
  it.each([
    ["darwin", "macos"],
    ["win32", "windows"],
    ["linux", "linux"]
  ] as const)("maps host platform %s to target %s", (platform, expected) => {
    expect(hostTarget(platform)).toBe(expected);
  });

  it("throws a [native] error with a fix-it for an unsupported host platform", () => {
    expect(() => hostTarget("freebsd")).toThrow(/^\[native\] No default packaging target/);
    expect(() => hostTarget("freebsd")).toThrow(/Pass an explicit target/);
  });
});

describe("createCliApi — build", () => {
  it("{ all: true } calls runAll and ignores an explicit target", async () => {
    const { ctx, deps, mocks } = createMockCtx();
    const api = createCliApi(ctx, deps);

    await api.build({ all: true, target: "android" });

    expect(mocks.build.runAll).toHaveBeenCalledOnce();
    expect(mocks.build.run).not.toHaveBeenCalled();
  });

  it("uses the explicit target when given", async () => {
    const { ctx, deps, mocks } = createMockCtx();
    const api = createCliApi(ctx, deps);

    await api.build({ target: "android" });

    expect(mocks.build.run).toHaveBeenCalledWith({
      target: "android",
      simulator: undefined,
      aab: undefined
    });
  });

  it("falls back to the resolved host target when omitted", async () => {
    const { ctx, deps, mocks } = createMockCtx();
    const api = createCliApi(ctx, deps);

    await api.build();

    expect(mocks.build.run).toHaveBeenCalledWith({
      target: hostTarget(),
      simulator: undefined,
      aab: undefined
    });
  });

  it("passes simulator through to build.run", async () => {
    const { ctx, deps, mocks } = createMockCtx();
    const api = createCliApi(ctx, deps);

    await api.build({ target: "ios", simulator: true });

    expect(mocks.build.run).toHaveBeenCalledWith({
      target: "ios",
      simulator: true,
      aab: undefined
    });
  });

  it("passes aab through to build.run", async () => {
    const { ctx, deps, mocks } = createMockCtx();
    const api = createCliApi(ctx, deps);

    await api.build({ target: "android", aab: true });

    expect(mocks.build.run).toHaveBeenCalledWith({
      target: "android",
      simulator: undefined,
      aab: true
    });
  });

  it("passes simulator/aab through to build.runAll", async () => {
    const { ctx, deps, mocks } = createMockCtx();
    const api = createCliApi(ctx, deps);

    await api.build({ all: true, simulator: true, aab: true });

    expect(mocks.build.runAll).toHaveBeenCalledWith({ simulator: true, aab: true });
  });

  it("boxes the TauriError stderr tail before rethrowing", async () => {
    const lines: string[] = [];
    const mocks = createMocks();
    mocks.build.run = vi.fn().mockRejectedValue(
      new TauriError("compile-failed", "[native] tauri compile failed.\n  Fix the source.", {
        exitCode: 101,
        stderrTail: "error[E0432]: unresolved import `foo`"
      })
    );
    const { ctx, deps } = createMockCtx({
      mocks,
      renderImpl: line => {
        lines.push(line);
      }
    });
    const api = createCliApi(ctx, deps);

    await expect(api.build({ target: "macos" })).rejects.toThrow(/tauri compile failed/);

    const text = lines.join("\n");
    expect(text).toContain("unresolved import `foo`");
    expect(text.indexOf("unresolved import")).toBeLessThan(text.indexOf("[native] tauri compile"));
  });

  it("rethrows a non-TauriError failure without boxing anything", async () => {
    const lines: string[] = [];
    const mocks = createMocks();
    mocks.build.runAll = vi.fn().mockRejectedValue(new Error("[native] boom.\n  Retry."));
    const { ctx, deps } = createMockCtx({
      mocks,
      renderImpl: line => {
        lines.push(line);
      }
    });
    const api = createCliApi(ctx, deps);

    await expect(api.build({ all: true })).rejects.toThrow(/boom/);
    expect(lines.length).toBeLessThanOrEqual(2);
  });
});

describe("createCliApi — dev", () => {
  it("prepares the project before handing the tree to tauri dev", async () => {
    const order: string[] = [];
    const mocks = createMocks();
    mocks.build.prepare = vi.fn(async () => {
      order.push("prepare");
    });
    mocks.tauri.dev = vi.fn(async () => {
      order.push("dev");
      return {
        url: "http://localhost:1420",
        ready: Promise.resolve(),
        exited: Promise.resolve({ code: 0, signal: null }),
        stop: vi.fn()
      };
    });
    const { ctx, deps } = createMockCtx({ mocks });
    const api = createCliApi(ctx, deps);

    await api.dev();

    expect(order).toEqual(["prepare", "dev"]);
    expect(mocks.build.prepare).toHaveBeenCalledWith({ target: hostTarget() });
  });

  it("forwards an explicit target to both prepare and tauri dev", async () => {
    const { ctx, deps, mocks } = createMockCtx();
    const api = createCliApi(ctx, deps);

    await api.dev({ target: "ios" });

    expect(mocks.build.prepare).toHaveBeenCalledWith({ target: "ios" });
    expect(mocks.tauri.dev).toHaveBeenCalledWith(
      expect.objectContaining({ target: "ios" }) as unknown
    );
  });

  it("never starts the dev process when prepare fails", async () => {
    const mocks = createMocks();
    mocks.build.prepare = vi.fn().mockRejectedValue(new Error("[native] codegen failed.\n  Fix."));
    const { ctx, deps } = createMockCtx({ mocks });
    const api = createCliApi(ctx, deps);

    await expect(api.dev()).rejects.toThrow(/codegen failed/);
    expect(mocks.tauri.dev).not.toHaveBeenCalled();
  });

  it("renders a failed prepare exactly like a failed build: tail boxed, then the error line", async () => {
    const lines: string[] = [];
    const mocks = createMocks();
    mocks.build.prepare = vi.fn().mockRejectedValue(
      new TauriError("xcode-script-failed", "[native] tauri ios init failed.\n  Run doctor.", {
        exitCode: 65,
        stderrTail: "xcodebuild: error: Unable to find a destination"
      })
    );
    const { ctx, deps } = createMockCtx({
      mocks,
      renderImpl: line => {
        lines.push(line);
      }
    });
    const api = createCliApi(ctx, deps);

    await expect(api.dev({ target: "ios" })).rejects.toThrow(/tauri ios init failed/);

    const text = lines.join("\n");
    expect(text).toContain("Unable to find a destination");
    expect(text.indexOf("Unable to find")).toBeLessThan(text.indexOf("[native] tauri ios init"));
  });

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
    const { ctx, deps } = createMockCtx({
      mocks,
      renderImpl: line => {
        lines.push(line);
      }
    });
    const api = createCliApi(ctx, deps);

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
    const { ctx, deps } = createMockCtx({ mocks });
    const api = createCliApi(ctx, deps);

    await expect(api.dev()).rejects.toThrow(/tauri dev exited with code 1/);
  });

  it("resolves cleanly on a signal-terminated exit (Ctrl-C → code null)", async () => {
    const mocks = createMocks();
    mocks.tauri.dev = vi.fn().mockResolvedValue({
      url: "http://localhost:1420",
      ready: Promise.resolve(),
      exited: Promise.resolve({ code: null, signal: "SIGTERM" }),
      stop: vi.fn()
    });
    const { ctx, deps } = createMockCtx({ mocks });
    const api = createCliApi(ctx, deps);

    await expect(api.dev()).resolves.toBeUndefined();
  });
});

describe("createCliApi — doctor", () => {
  it("returns report.ok and renders counts only — never a second row per check", async () => {
    const mocks = createMocks();
    mocks.doctor.run = vi.fn().mockResolvedValue({
      ok: false,
      checks: [
        { id: "x", target: "host", status: "fail", message: "boom", fixIt: "install x" },
        { id: "y", target: "host", status: "pass", message: "fine" }
      ]
    });
    const lines: string[] = [];
    const { ctx, deps } = createMockCtx({
      mocks,
      renderImpl: line => {
        lines.push(line);
      }
    });
    const api = createCliApi(ctx, deps);

    const ok = await api.doctor();

    expect(ok).toBe(false);
    expect(mocks.doctor.run).toHaveBeenCalledWith({});
    const text = lines.join("\n");
    expect(text).toContain("pass 1");
    expect(text).toContain("fail 1");
    expect(text).toContain("One or more checks failed");
    // The rows themselves belong to the live doctor:check hook, not the summary.
    expect(text).not.toContain("boom");
    expect(text).not.toContain("install x");
  });

  it("forwards an explicit target", async () => {
    const { ctx, deps, mocks } = createMockCtx();
    const api = createCliApi(ctx, deps);

    await api.doctor({ target: "ios" });

    expect(mocks.doctor.run).toHaveBeenCalledWith({ target: "ios" });
  });
});

describe("createCliApi — clean", () => {
  it("without a target: aborts without cleaning when confirm resolves false", async () => {
    const confirmImpl = vi.fn().mockResolvedValue(false);
    const { ctx, deps, mocks } = createMockCtx({ confirmImpl });
    const api = createCliApi(ctx, deps);

    await api.clean();

    expect(confirmImpl).toHaveBeenCalledOnce();
    expect(mocks.project.clean).not.toHaveBeenCalled();
  });

  it("without a target: delegates to project.clean when confirm resolves true", async () => {
    const confirmImpl = vi.fn().mockResolvedValue(true);
    const { ctx, deps, mocks } = createMockCtx({ confirmImpl });
    const api = createCliApi(ctx, deps);

    await api.clean();

    expect(mocks.project.clean).toHaveBeenCalledWith({});
  });

  it("with a target: skips confirm and delegates directly", async () => {
    const confirmImpl = vi.fn();
    const { ctx, deps, mocks } = createMockCtx({ confirmImpl });
    const api = createCliApi(ctx, deps);

    await api.clean({ target: "android" });

    expect(confirmImpl).not.toHaveBeenCalled();
    expect(mocks.project.clean).toHaveBeenCalledWith({ target: "android" });
  });
});
