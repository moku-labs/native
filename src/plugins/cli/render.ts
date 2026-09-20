/**
 * @file cli plugin — branded-kit composition (MC1): render/confirm seam resolution plus
 * pure line/box formatters for native:phase, native:complete, and doctor:check.
 */

import type { BrandConsole } from "@moku-labs/common/cli";
import { createBrandConsole, createBrandPrompts, spinnerFrameAt } from "@moku-labs/common/cli";
import type { NativeCompleteEvent, NativePhaseEvent } from "../../config";
import type { CheckResult, DoctorReport } from "../doctor/types";
import { TauriError } from "../tauri/errors";
import type { ConfirmFn, RenderFn } from "./types";

/**
 * Creates the branded console bound to the injected render seam. When `renderImpl` is
 * provided every line flows through it (both the normal and error sinks) instead of the
 * branded kit's own `console.log`/`console.error` default — the seam tests inject to
 * capture output deterministically and assert zero raw `console.*` calls (MC1).
 *
 * @param renderImpl - Injected line sink (default: undefined → branded console default).
 * @returns A branded console writing every line through the render seam.
 * @example
 * ```ts
 * const ui = createRenderConsole(ctx.config.renderImpl);
 * ui.info("ready");
 * ```
 */
export function createRenderConsole(renderImpl: RenderFn | undefined): BrandConsole {
  return renderImpl
    ? createBrandConsole({ write: renderImpl, writeError: renderImpl })
    : createBrandConsole();
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

/**
 * Renders a failed build: the classified {@link TauriError}'s scrubbed stderr tail framed
 * in a branded box, then the `[native]` error line. Cause first, verdict second —
 * the tail is the only place the real toolchain diagnostic survives. A non-`TauriError`
 * failure (or an empty tail) prints the error line alone.
 *
 * @param ui - The branded console to render through.
 * @param error - The failure thrown by `build.run`/`build.runAll`.
 * @example
 * ```ts
 * try { await build.run({ target: "macos" }); } catch (error) { renderBuildFailure(ui, error); throw error; }
 * ```
 */
export function renderBuildFailure(ui: BrandConsole, error: unknown): void {
  const stderrTail = error instanceof TauriError ? error.stderrTail.trim() : "";

  if (stderrTail) ui.box(stderrTail.split(/\r?\n/));
  ui.error(error instanceof Error ? error.message : String(error));
}
