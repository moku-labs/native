import { describe, expect, it, vi } from "vitest";
import type { NativeCompleteEvent, NativePhaseEvent } from "../../../../config";
import type { CheckResult } from "../../../doctor/types";
import { createCliHandlers } from "../../handlers";
import { createCliState } from "../../state";
import type { CliContext, Config } from "../../types";

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

/** Builds a mock `CliContext` bound to the given render sink (default: swallow every line). */
function createMockCtx(renderImpl: (line: string) => void = () => {}): CliContext {
  const config: Config = { renderImpl, confirmImpl: undefined };

  return {
    global: validGlobalConfig,
    config,
    // The real state factory — the branded console is created ONCE there (N5).
    state: createCliState({ global: validGlobalConfig, config }),
    require: vi.fn() as CliContext["require"]
  };
}

describe("createCliHandlers — native:phase state transitions", () => {
  it("start stamps startedAt in ctx.state.progress", () => {
    const ctx = createMockCtx();
    const handlers = createCliHandlers(ctx);
    const payload: NativePhaseEvent = { target: "macos", phase: "scaffold", status: "start" };

    handlers["native:phase"](payload);

    expect(ctx.state.progress.startedAt).toBeTypeOf("number");
  });

  it("progress keeps the running phase's startedAt untouched", () => {
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

    expect(ctx.state.progress).toEqual({ startedAt: undefined });
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

    expect(ctx.state.progress).toEqual({ startedAt: undefined });
  });
});

describe("createCliHandlers — rendering", () => {
  it("renders through the one state-owned console for phase/complete/check events (N5)", () => {
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

  it("renders doctor rows only from the hook — one row per doctor:check event (M7)", () => {
    const lines: string[] = [];
    const ctx = createMockCtx(line => lines.push(line));
    const handlers = createCliHandlers(ctx);

    handlers["doctor:check"]({ id: "node-binary", target: "host", status: "pass", message: "ok" });

    const occurrences = lines.filter(line => line.includes("node-binary"));
    expect(occurrences).toHaveLength(1);
  });
});
