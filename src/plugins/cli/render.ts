/**
 * @file cli plugin — branded-kit composition (MC1): render/confirm seam resolution plus
 * pure line/box formatters for native:phase, native:complete, and doctor:check.
 */

import type { LogEntry, LogLevel, LogSink } from "@moku-labs/common";
import type { BrandConsole } from "@moku-labs/common/cli";
import { createBrandConsole, createBrandPrompts, spinnerFrameAt } from "@moku-labs/common/cli";
import type { NativeCompleteEvent, NativePhaseEvent } from "../../config";
import type { CheckResult, DoctorReport } from "../doctor/types";
import { TauriError } from "../tauri/errors";
import type { ConfirmFn, RenderFn } from "./types";

/** Narrowest console width: below it a boxed diagnostic is cut so short it names nothing. */
const MIN_CONSOLE_WIDTH = 60;

/** Widest console width: past it a boxed diagnostic is too wide to scan. */
const MAX_CONSOLE_WIDTH = 160;

/** Width used when the stream reports no columns (CI, pipes) — the branded kit's own default. */
const FALLBACK_CONSOLE_WIDTH = 66;

/**
 * The width the branded console aligns to: the terminal's own column count, clamped to a
 * readable range, or the kit default when the stream has no columns (CI, pipes). This is
 * the single place a raw `process.stdout` read happens — the column count is injectable so
 * nothing downstream depends on the real terminal.
 *
 * @param columns - The stream's column count (default: `process.stdout.columns`).
 * @returns The console width, between 60 and 160 inclusive.
 * @example
 * ```ts
 * terminalWidth(120);       // 120
 * terminalWidth(40);        // 60 — clamped up
 * terminalWidth(undefined); // 66 — piped output
 * ```
 */
export function terminalWidth(columns: number | undefined = process.stdout.columns): number {
  if (columns === undefined) return FALLBACK_CONSOLE_WIDTH;
  return Math.min(MAX_CONSOLE_WIDTH, Math.max(MIN_CONSOLE_WIDTH, columns));
}

/**
 * Creates the branded console bound to the injected render seam, aligned to the terminal
 * width. When `renderImpl` is provided every line flows through it (both the normal and
 * error sinks) instead of the branded kit's own `console.log`/`console.error` default — the
 * seam tests inject to capture output deterministically and assert zero raw `console.*`
 * calls (MC1). The column count is injectable the same way, so the width a test renders at
 * never depends on the terminal the test runs in.
 *
 * @param renderImpl - Injected line sink (default: undefined → branded console default).
 * @param columns - Injected column count (default: undefined → `process.stdout.columns`).
 * @returns A branded console writing every line through the render seam.
 * @example
 * ```ts
 * const ui = createRenderConsole(ctx.config.renderImpl);
 * ui.info("ready");
 * ```
 */
export function createRenderConsole(
  renderImpl: RenderFn | undefined,
  columns?: number
): BrandConsole {
  const width = terminalWidth(columns);
  return renderImpl
    ? createBrandConsole({ write: renderImpl, writeError: renderImpl, width })
    : createBrandConsole({ width });
}

/** Severity order — an entry ranking below the sink's threshold is dropped. */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Formats a record's structured payload as a dim trailing JSON fragment, so a log line
 * stays one readable line instead of a printed object.
 *
 * @param ui - The branded console supplying the palette.
 * @param data - The record's optional structured payload.
 * @returns The dim ` {"…":…}` suffix, or an empty string when there is no payload.
 * @example
 * ```ts
 * formatEntryData(ui, { written: 7 }); // ' {"written":7}' (dim)
 * ```
 */
function formatEntryData(ui: BrandConsole, data: unknown): string {
  if (data === undefined) return "";
  try {
    const text = JSON.stringify(data);
    return text === undefined ? "" : ` ${ui.palette.dim(text)}`;
  } catch {
    return ` ${ui.palette.dim(String(data))}`;
  }
}

/**
 * Builds the log sink the cli plugin installs over the framework's default one: every
 * `ctx.log` record renders as a branded line through THIS plugin's console, so structured
 * records and CLI UI share one surface (MC1) instead of raw `{ level, event, data, ts }`
 * objects appearing between the branded lines.
 *
 * It takes the console rather than building its own, which is what keeps the injected
 * render seam whole: with `renderImpl` set, log lines are captured with everything else.
 *
 * @param ui - The branded console to render through.
 * @param minLevel - Lowest severity to render (default `"info"` — debug detail stays in the trace).
 * @returns A log sink writing branded lines through `ui`.
 * @example
 * ```ts
 * ctx.log.clearSinks();
 * ctx.log.addSink(createLogSink(ctx.state.ui));
 * ```
 */
export function createLogSink(ui: BrandConsole, minLevel: LogLevel = "info"): LogSink {
  const threshold = LEVEL_RANK[minLevel];

  return {
    /**
     * Renders one record as the branded line matching its level.
     *
     * @param entry - The record to render.
     * @example
     * ```ts
     * sink.write({ level: "info", event: "project:generate", ts: Date.now() });
     * ```
     */
    write(entry: LogEntry): void {
      if (LEVEL_RANK[entry.level] < threshold) return;
      const message = `${entry.event}${formatEntryData(ui, entry.data)}`;

      switch (entry.level) {
        case "error": {
          ui.error(message);
          break;
        }
        case "warn": {
          ui.warn(message);
          break;
        }
        case "debug": {
          ui.line(`  ${ui.palette.dim(message)}`);
          break;
        }
        default: {
          ui.info(message);
        }
      }
    }
  };
}

/**
 * Resolves the confirm seam: the injected `confirmImpl`, or a styled y/N prompt from the
 * branded kit.
 *
 * @param confirmImpl - Injected confirm seam (default: undefined → branded prompt).
 * @returns The resolved confirm function.
 * @example
 * ```ts
 * const confirm = resolveConfirm(ctx.config.confirmImpl);
 * await confirm("Wipe the project directory?");
 * ```
 */
export function resolveConfirm(confirmImpl: ConfirmFn | undefined): ConfirmFn {
  return confirmImpl ?? (question => createBrandPrompts().confirm(question));
}

/**
 * Renders one `native:phase` status line: a spinner line on `start`, a detail line on
 * `progress` (real ticks only — silent when `detail` is absent), and a pass/fail
 * diagnostic line with duration on `done`/`error`. The v1 icons no-op (D-015) renders as an
 * ordinary `done` line whose detail happens to read `"skipped"`.
 *
 * @param ui - The branded console to render through.
 * @param payload - The phase event payload.
 * @param elapsedMs - Milliseconds since the phase started (drives the spinner frame).
 * @example
 * ```ts
 * renderPhaseEvent(ui, { target: "macos", phase: "compile", status: "start" }, 0);
 * ```
 */
export function renderPhaseEvent(
  ui: BrandConsole,
  payload: NativePhaseEvent,
  elapsedMs: number
): void {
  const label = `${payload.target} · ${payload.phase}`;

  if (payload.status === "start") {
    ui.line(`  ${spinnerFrameAt(elapsedMs)} ${label}…`);
    return;
  }

  if (payload.status === "progress") {
    if (payload.detail) ui.line(`  ${spinnerFrameAt(elapsedMs)} ${label} — ${payload.detail}`);
    return;
  }

  if (payload.status === "done") {
    const durationLabel = `${payload.durationMs ?? 0}ms`;
    ui.check(true, label, payload.detail ? `${payload.detail} (${durationLabel})` : durationLabel);
    return;
  }

  ui.check(false, label, payload.detail);
}

/**
 * Renders the `native:complete` summary panel — app name, target, artifact paths, and
 * total duration — as a branded box (`app.name` is the panel header, per config's
 * "Global fields consumed").
 *
 * @param ui - The branded console to render through.
 * @param payload - The completion event payload.
 * @param appName - The composed app's display name.
 * @example
 * ```ts
 * renderCompleteEvent(ui, { target: "macos", outPath: "dist-native/macos", artifacts: [], durationMs: 42000 }, "Demo");
 * ```
 */
export function renderCompleteEvent(
  ui: BrandConsole,
  payload: NativeCompleteEvent,
  appName: string
): void {
  const lines = [
    `${appName} — ${payload.target} build complete`,
    `Target     ${payload.target}`,
    `Output     ${payload.outPath}`,
    ...payload.artifacts.map(artifact => `Artifact   ${artifact}`),
    `Duration   ${payload.durationMs}ms`
  ];
  ui.box(lines);
}

/**
 * Renders one live `doctor:check` row — pass/warn/fail symbol, message, and an indented
 * fix-it when present. `warn` gets its own dim `~` marker (never flips to fail styling);
 * `pass`/`fail` reuse the branded console's own `check` diagnostic line.
 *
 * @param ui - The branded console to render through.
 * @param result - The completed check result.
 * @example
 * ```ts
 * renderCheckEvent(ui, { id: "node-binary", target: "host", status: "pass", message: "node found" });
 * ```
 */
export function renderCheckEvent(ui: BrandConsole, result: CheckResult): void {
  const label = `${result.target} · ${result.id} — ${result.message}`;

  if (result.status === "warn") {
    ui.line(`  ${ui.palette.yellow("~")} ${label}`);
    if (result.fixIt) ui.line(`      ${ui.palette.dim(result.fixIt)}`);
    return;
  }

  ui.check(result.status === "pass", label, result.fixIt);
}

/**
 * Renders the final doctor summary once the full report has resolved: a heading, the
 * pass/warn/fail counts, and the overall verdict. It repeats NO row — every check already
 * printed exactly once, live from the `doctor:check` hook.
 *
 * @param ui - The branded console to render through.
 * @param report - The aggregated diagnosis report.
 * @example
 * ```ts
 * renderDoctorSummary(ui, await app.doctor.run());
 * ```
 */
export function renderDoctorSummary(ui: BrandConsole, report: DoctorReport): void {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const result of report.checks) counts[result.status] += 1;

  ui.heading("Doctor summary");
  ui.line(`  pass ${counts.pass} · warn ${counts.warn} · fail ${counts.fail}`);
  ui.check(report.ok, report.ok ? "All checks passed" : "One or more checks failed");
}

/** Columns the box's own borders and padding occupy around a tail line. */
const BOX_CHROME_COLUMNS = 6;

/**
 * Floor for the tail budget. Below this a diagnostic is cut so short it names nothing, so a
 * very narrow console gets a wrapped line rather than a useless one.
 */
const MIN_TAIL_LINE_LENGTH = 40;

/**
 * Decides how wide a tail line may be — or that it may be any width at all.
 *
 * With a terminal attached, the bound follows the real terminal ({@link terminalWidth}
 * clamps it) minus the box chrome: a single Rust/xcodebuild diagnostic can run thousands of
 * characters and would wrap the branded box into unreadable noise.
 *
 * With no terminal — CI, `native build > build.log`, a piped run — there is nothing to wrap
 * against, and the output is READ afterwards: truncating there deletes the one copy of the
 * toolchain's own error text. So a stream without columns gets no bound at all.
 *
 * @param columns - The stream's column count (`process.stdout.columns`), undefined when piped.
 * @returns The maximum tail line length, or undefined when lines must be kept whole.
 * @example
 * ```ts
 * tailLineBound(120);       // 114
 * tailLineBound(40);        // 54 — clamped up to 60, minus the chrome
 * tailLineBound(undefined); // undefined — piped: keep the full line
 * ```
 */
export function tailLineBound(columns: number | undefined): number | undefined {
  if (columns === undefined) return undefined;
  return Math.max(MIN_TAIL_LINE_LENGTH, terminalWidth(columns) - BOX_CHROME_COLUMNS);
}

/**
 * Truncates one tail line to `budget`, marking the cut with an ellipsis. An undefined
 * budget keeps the line whole.
 *
 * @param line - One line of the scrubbed stderr tail.
 * @param budget - The maximum length, from {@link tailLineBound}.
 * @returns The line, at most `budget` characters long.
 * @example
 * ```ts
 * truncateLine("error: " + "x".repeat(400), 60); // "error: xxx…"
 * ```
 */
function truncateLine(line: string, budget: number | undefined): string {
  if (budget === undefined || line.length <= budget) return line;
  return `${line.slice(0, budget - 1)}…`;
}

/**
 * Renders a failed build: the classified {@link TauriError}'s scrubbed stderr tail framed
 * in a branded box, then the `[native]` error line. Cause first, verdict second —
 * the tail is the only place the real toolchain diagnostic survives. A non-`TauriError`
 * failure (or an empty tail) prints the error line alone.
 *
 * Tail lines are cut to the terminal's width, and only when there IS a terminal: piped and
 * CI output keeps every line whole ({@link tailLineBound}).
 *
 * @param ui - The branded console to render through.
 * @param error - The failure thrown by `build.run`/`build.runAll`.
 * @param columns - The stream's column count (default: `process.stdout.columns`).
 * @example
 * ```ts
 * try { await build.run({ target: "macos" }); } catch (error) { renderBuildFailure(ui, error); throw error; }
 * ```
 */
export function renderBuildFailure(
  ui: BrandConsole,
  error: unknown,
  columns: number | undefined = process.stdout.columns
): void {
  const stderrTail = error instanceof TauriError ? error.stderrTail.trim() : "";
  const budget = tailLineBound(columns);

  if (stderrTail) ui.box(stderrTail.split(/\r?\n/).map(line => truncateLine(line, budget)));
  ui.error(error instanceof Error ? error.message : String(error));
}
