import { describe, expect, it, vi } from "vitest";
import type { NativeCompleteEvent, NativePhaseEvent } from "../../../../config";
import type { CheckResult } from "../../../doctor/types";
import { createCliHandlers } from "../../handlers";
import type { CliContext } from "../../types";

/** Builds a mock `CliContext` bound to the given render sink (default: swallow every line). */
function createMockCtx(renderImpl: (line: string) => void = () => {}): CliContext {
  return {
    global: {
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
    },
    config: { renderImpl, confirmImpl: undefined },
    state: { progress: { phase: undefined, startedAt: undefined, ticks: 0 } },
    require: vi.fn() as CliContext["require"]
  };
}

describe("createCliHandlers — native:phase state transitions", () => {
  it("start sets phase/startedAt/ticks in ctx.state.progress", () => {
    const ctx = createMockCtx();
    const handlers = createCliHandlers(ctx);
    const payload: NativePhaseEvent = { target: "macos", phase: "scaffold", status: "start" };

    handlers["native:phase"](payload);

    expect(ctx.state.progress.phase).toBe("scaffold");
    expect(ctx.state.progress.startedAt).toBeTypeOf("number");
    expect(ctx.state.progress.ticks).toBe(0);
  });

  it("progress increments ticks without resetting phase or startedAt", () => {
    const ctx = createMockCtx();
    const handlers = createCliHandlers(ctx);

    handlers["native:phase"]({ target: "macos", phase: "compile", status: "start" });
    const startedAt = ctx.state.progress.startedAt;
    handlers["native:phase"]({
      target: "macos",
      phase: "compile",
      status: "progress",
      detail: "1/2"
    });
    handlers["native:phase"]({
      target: "macos",
      phase: "compile",
      status: "progress",
      detail: "2/2"
    });

    expect(ctx.state.progress.ticks).toBe(2);
    expect(ctx.state.progress.phase).toBe("compile");
    expect(ctx.state.progress.startedAt).toBe(startedAt);
  });

  it("done clears progress back to no active phase", () => {
    const ctx = createMockCtx();
    const handlers = createCliHandlers(ctx);

    handlers["native:phase"]({ target: "macos", phase: "scaffold", status: "start" });
    handlers["native:phase"]({
      target: "macos",
      phase: "scaffold",
      status: "done",
      durationMs: 5
    });

    expect(ctx.state.progress).toEqual({ phase: undefined, startedAt: undefined, ticks: 0 });
  });

  it("error also clears progress back to no active phase", () => {
    const ctx = createMockCtx();
    const handlers = createCliHandlers(ctx);

    handlers["native:phase"]({ target: "macos", phase: "compile", status: "start" });
    handlers["native:phase"]({
      target: "macos",
      phase: "compile",
      status: "error",
      durationMs: 5,
      detail: "boom"
    });

    expect(ctx.state.progress).toEqual({ phase: undefined, startedAt: undefined, ticks: 0 });
  });
});

describe("createCliHandlers — rendering", () => {
  it("renders through the injected render seam for phase/complete/check events", () => {
    const lines: string[] = [];
    const ctx = createMockCtx(line => lines.push(line));
    const handlers = createCliHandlers(ctx);

    handlers["native:phase"]({ target: "macos", phase: "scaffold", status: "start" });

    const completePayload: NativeCompleteEvent = {
      target: "macos",
      outPath: "dist-native/macos",
      artifacts: ["dist-native/macos/App.dmg"],
      durationMs: 1000
    };
    handlers["native:complete"](completePayload);

    const check: CheckResult = { id: "node-binary", target: "host", status: "pass", message: "ok" };
    handlers["doctor:check"](check);

    const text = lines.join("\n");
    expect(text).toContain("scaffold");
    expect(text).toContain("App.dmg");
    expect(text).toContain("Test App");
    expect(text).toContain("node-binary");
  });
});
