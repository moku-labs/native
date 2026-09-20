import { describe, expect, it, vi } from "vitest";
import type { NativeCompleteEvent, NativePhaseEvent } from "../../../../config";
import type { CheckResult, DoctorReport } from "../../../doctor/types";
import { TauriError } from "../../../tauri/errors";
import {
  createLogSink,
  createRenderConsole,
  renderBuildFailure,
  renderCheckEvent,
  renderCompleteEvent,
  renderDoctorSummary,
  renderPhaseEvent,
  resolveConfirm,
  terminalWidth
} from "../../render";

/** Builds a capturing render sink and the branded console bound to it. */
function createSink(columns?: number) {
  const lines: string[] = [];
  const sink = (line: string): void => {
    lines.push(line);
  };
  return { lines, sink, ui: createRenderConsole(sink, columns) };
}

/** Matches the ellipsis-terminated tail content inside the failure box. */
const TRUNCATED_TAIL = /error: x+…/;

/**
 * Pulls the truncated tail line out of captured box output, stripped of box chrome.
 *
 * @param lines - Every line the sink captured.
 * @returns The truncated tail content, or an empty string when nothing was truncated.
 */
function truncatedTail(lines: string[]): string {
  return lines.map(line => TRUNCATED_TAIL.exec(line)?.[0]).find(Boolean) ?? "";
}

/** A classified failure whose stderr tail is one line wider than any terminal. */
function longTailError(): TauriError {
  return new TauriError("compile-failed", "[native] tauri compile failed.\n  Fix it.", {
    exitCode: 101,
    stderrTail: `error: ${"x".repeat(200)}`
  });
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

  it("truncates the tail to the terminal width on a wide terminal (120 → 114)", () => {
    const { lines, ui } = createSink(120);

    renderBuildFailure(ui, longTailError());

    expect(truncatedTail(lines)).toHaveLength(114);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
  });

  it("truncates to the 66-column fallback when the stream reports no columns (→ 60)", () => {
    const { lines, ui } = createSink(terminalWidth(undefined));

    renderBuildFailure(ui, longTailError());

    expect(truncatedTail(lines)).toHaveLength(60);
  });

  it("truncates to the clamped minimum on a very narrow terminal (40 → 60 → 54)", () => {
    const { lines, ui } = createSink(40);

    renderBuildFailure(ui, longTailError());

    expect(truncatedTail(lines)).toHaveLength(54);
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

describe("terminalWidth", () => {
  it("follows the terminal column count", () => {
    expect(terminalWidth(120)).toBe(120);
  });

  it("falls back to 66 when the stream reports no columns (CI, pipes)", () => {
    expect(terminalWidth(undefined)).toBe(66);
  });

  it("clamps a very narrow terminal up to 60", () => {
    expect(terminalWidth(40)).toBe(60);
  });

  it("clamps a very wide terminal down to 160", () => {
    expect(terminalWidth(400)).toBe(160);
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

describe("createLogSink", () => {
  it("renders a structured record as one branded line, event first", () => {
    const { lines, ui } = createSink();

    createLogSink(ui).write({ level: "info", event: "project:generate", ts: 0 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("project:generate");
    expect(lines[0]).not.toContain('"level"');
  });

  it("appends the structured payload as JSON instead of a printed object", () => {
    const { lines, ui } = createSink();

    createLogSink(ui).write({
      level: "info",
      event: "project:generate",
      data: { target: "macos", written: 7 },
      ts: 0
    });

    expect(lines.join("\n")).toContain('{"target":"macos","written":7}');
  });

  it("routes warn and error through the console's own warn/error lines", () => {
    const { lines, ui } = createSink();
    const sink = createLogSink(ui);

    sink.write({ level: "warn", event: "doctor:slow", ts: 0 });
    sink.write({ level: "error", event: "build:failed", ts: 0 });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("doctor:slow");
    expect(lines[1]).toContain("build:failed");
  });

  it("drops entries below the threshold — debug spam never reaches the UI", () => {
    const { lines, ui } = createSink();

    createLogSink(ui).write({ level: "debug", event: "tauri:info-raw", ts: 0 });

    expect(lines).toEqual([]);
  });

  it("keeps debug when the threshold is lowered to it", () => {
    const { lines, ui } = createSink();

    createLogSink(ui, "debug").write({ level: "debug", event: "tauri:info-raw", ts: 0 });

    expect(lines).toHaveLength(1);
  });

  it("writes through the injected seam only — never raw console.*", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ui } = createSink();

    createLogSink(ui).write({ level: "error", event: "build:failed", data: { code: 1 }, ts: 0 });

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
