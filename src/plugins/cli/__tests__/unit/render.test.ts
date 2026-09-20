import { describe, expect, it, vi } from "vitest";
import type { NativeCompleteEvent, NativePhaseEvent } from "../../../../config";
import type { CheckResult, DoctorReport } from "../../../doctor/types";
import { TauriError } from "../../../tauri/errors";
import {
  createRenderConsole,
  renderBuildFailure,
  renderCheckEvent,
  renderCompleteEvent,
  renderDoctorSummary,
  renderPhaseEvent,
  resolveConfirm
} from "../../render";

/** Builds a capturing render sink and the branded console bound to it. */
function createSink() {
  const lines: string[] = [];
  const sink = (line: string): void => {
    lines.push(line);
  };
  return { lines, sink, ui: createRenderConsole(sink) };
}

describe("renderPhaseEvent", () => {
  it("renders a spinner line on start", () => {
    const { lines, ui } = createSink();
    const payload: NativePhaseEvent = { target: "macos", phase: "scaffold", status: "start" };

    renderPhaseEvent(ui, payload, 0);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("scaffold");
  });

  it("stays silent on progress when detail is absent (real ticks only)", () => {
    const { lines, ui } = createSink();

    renderPhaseEvent(ui, { target: "macos", phase: "compile", status: "progress" }, 100);

    expect(lines).toHaveLength(0);
  });

  it("renders the detail on progress when present", () => {
    const { lines, ui } = createSink();

    renderPhaseEvent(
      ui,
      { target: "macos", phase: "compile", status: "progress", detail: "Compiling crate 3/10" },
      100
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Compiling crate 3/10");
  });

  it("renders a pass line with duration on done", () => {
    const { lines, ui } = createSink();

    renderPhaseEvent(ui, { target: "macos", phase: "scaffold", status: "done", durationMs: 12 }, 0);

    const text = lines.join("\n");
    expect(text).toContain("✓");
    expect(text).toContain("12ms");
  });

  it("handles the v1 icons no-op done event gracefully", () => {
    const { lines, ui } = createSink();

    renderPhaseEvent(
      ui,
      { target: "macos", phase: "icons", status: "done", durationMs: 1, detail: "skipped" },
      0
    );

    const text = lines.join("\n");
    expect(text).toContain("✓");
    expect(text).toContain("skipped");
  });

  it("renders a fail line with detail on error", () => {
    const { lines, ui } = createSink();

    renderPhaseEvent(
      ui,
      { target: "macos", phase: "compile", status: "error", durationMs: 40, detail: "boom" },
      0
    );

    const text = lines.join("\n");
    expect(text).toContain("✗");
    expect(text).toContain("boom");
  });
});

describe("renderCompleteEvent", () => {
  it("renders a box panel with app name header, target, artifacts, and duration", () => {
    const { lines, ui } = createSink();
    const payload: NativeCompleteEvent = {
      target: "macos",
      outPath: "dist-native/macos",
      artifacts: ["dist-native/macos/App_1.0.0.dmg"],
      durationMs: 42_000
    };

    renderCompleteEvent(ui, payload, "Demo App");

    const text = lines.join("\n");
    expect(text).toContain("Demo App");
    expect(text).toContain("macos");
    expect(text).toContain("App_1.0.0.dmg");
    expect(text).toContain("42000ms");
    // A box has at least a top border, one content line, and a bottom border.
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});

describe("renderCheckEvent", () => {
  it("renders a pass row", () => {
    const { lines, ui } = createSink();
    const result: CheckResult = {
      id: "node-binary",
      target: "host",
      status: "pass",
      message: "node found"
    };

    renderCheckEvent(ui, result);

    const text = lines.join("\n");
    expect(text).toContain("✓");
    expect(text).toContain("node found");
  });

  it("renders a warn row without flipping to fail styling", () => {
    const { lines, ui } = createSink();
    const result: CheckResult = {
      id: "signing-macos",
      target: "macos",
      status: "warn",
      message: "no signing identity",
      fixIt: "Set MOKU_SIGNING_IDENTITY"
    };

    renderCheckEvent(ui, result);

    const text = lines.join("\n");
    expect(text).not.toContain("✗");
    expect(text).toContain("~");
    expect(text).toContain("MOKU_SIGNING_IDENTITY");
  });

  it("renders a fail row with fix-it detail", () => {
    const { lines, ui } = createSink();
    const result: CheckResult = {
      id: "rustup-targets",
      target: "macos",
      status: "fail",
      message: "missing target",
      fixIt: "rustup target add aarch64-apple-darwin"
    };

    renderCheckEvent(ui, result);

    const text = lines.join("\n");
    expect(text).toContain("✗");
    expect(text).toContain("rustup target add aarch64-apple-darwin");
  });
});

describe("renderDoctorSummary", () => {
  /** A mixed report: one pass, one warn, one fail — one of each counted status. */
  const mixedReport: DoctorReport = {
    ok: false,
    checks: [
      { id: "node-binary", target: "host", status: "pass", message: "ok" },
      { id: "signing-macos", target: "macos", status: "warn", message: "no identity" },
      {
        id: "rustup-targets",
        target: "macos",
        status: "fail",
        message: "missing",
        fixIt: "rustup target add x"
      }
    ]
  };

  it("renders pass/warn/fail counts plus the overall verdict", () => {
    const { lines, ui } = createSink();

    renderDoctorSummary(ui, mixedReport);

    const text = lines.join("\n");
    expect(text).toContain("Doctor summary");
    expect(text).toContain("pass 1");
    expect(text).toContain("warn 1");
    expect(text).toContain("fail 1");
    expect(text).toContain("One or more checks failed");
  });

  it("never repeats the per-check rows — those print once, live from doctor:check", () => {
    const { lines, ui } = createSink();

    renderDoctorSummary(ui, mixedReport);

    const text = lines.join("\n");
    expect(text).not.toContain("node-binary");
    expect(text).not.toContain("rustup-targets");
    expect(text).not.toContain("rustup target add x");
  });

  it("renders the pass verdict for an all-green report", () => {
    const { lines, ui } = createSink();

    renderDoctorSummary(ui, {
      ok: true,
      checks: [{ id: "node-binary", target: "host", status: "pass", message: "ok" }]
    });

    const text = lines.join("\n");
    expect(text).toContain("pass 1");
    expect(text).toContain("All checks passed");
  });
});

describe("renderBuildFailure", () => {
  it("boxes the scrubbed stderr tail ABOVE the [native] error line", () => {
    const { lines, ui } = createSink();
    const error = new TauriError("compile-failed", "[native] tauri compile failed.\n  Fix it.", {
      exitCode: 101,
      stderrTail: "error[E0432]: unresolved import `foo`\nerror: could not compile `app`"
    });

    renderBuildFailure(ui, error);

    const text = lines.join("\n");
    expect(text).toContain("unresolved import `foo`");
    expect(text).toContain("could not compile `app`");
    expect(text).toContain("[native] tauri compile failed.");
    // Cause first, verdict second.
    expect(text.indexOf("unresolved import")).toBeLessThan(text.indexOf("[native] tauri compile"));
    // The tail is framed: a box adds a top border, content lines, and a bottom border.
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });

  it("truncates an over-long tail line to the branded console's own width", () => {
    const { lines, ui } = createSink();
    const longLine = `error: ${"x".repeat(400)}`;
    const error = new TauriError("compile-failed", "[native] tauri compile failed.\n  Fix it.", {
      exitCode: 101,
      stderrTail: longLine
    });

    renderBuildFailure(ui, error);

    const text = lines.join("\n");
    expect(text).toContain("…");
    // The whole box — borders included — fits the width the console aligns to, so it never
    // wraps in a terminal of that width.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(ui.width);
  });

  it("renders the error line without a box when the stderr tail is empty", () => {
    const { lines, ui } = createSink();
    const error = new TauriError("cancelled", "[native] tauri cancelled.\n  Retry.", {
      exitCode: null, // eslint-disable-line unicorn/no-null -- mirrors Node's signal-exit shape
      stderrTail: ""
    });

    renderBuildFailure(ui, error);

    const text = lines.join("\n");
    expect(text).toContain("[native] tauri cancelled.");
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("renders a plain error line for a non-TauriError failure", () => {
    const { lines, ui } = createSink();

    renderBuildFailure(ui, new Error("[native] collect phase found no artifacts.\n  Rebuild."));

    const text = lines.join("\n");
    expect(text).toContain("collect phase found no artifacts");
    expect(lines.length).toBeLessThanOrEqual(2);
  });
});

describe("branded-kit compliance", () => {
  it("never calls raw console.* when a render sink is injected", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ui } = createSink();

    renderPhaseEvent(ui, { target: "macos", phase: "scaffold", status: "start" }, 0);
    renderDoctorSummary(ui, { ok: true, checks: [] });
    renderBuildFailure(ui, new Error("[native] boom.\n  Retry."));

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("resolveConfirm", () => {
  it("returns the injected confirmImpl unchanged", async () => {
    const confirmImpl = vi.fn().mockResolvedValue(true);

    const confirm = resolveConfirm(confirmImpl);

    await expect(confirm("proceed?")).resolves.toBe(true);
    expect(confirmImpl).toHaveBeenCalledWith("proceed?");
  });
});
