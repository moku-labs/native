/**
 * @file cli plugin — event hook factories (live progress rendering, MC1).
 */
import type { NativeCompleteEvent, NativePhaseEvent } from "../../config";
import type { CheckResult } from "../doctor/types";
import { renderCheckEvent, renderCompleteEvent, renderPhaseEvent } from "./render";
import type { CliContext } from "./types";

/**
 * Hook map rendered by the cli plugin: `native:phase`/`native:complete` (global framework
 * events, no depends edge needed) and `doctor:check` (merged in via the doctor depends
 * edge, spec/07 §5).
 */
export type CliHandlers = {
  "native:phase": (payload: NativePhaseEvent) => void;
  "native:complete": (payload: NativeCompleteEvent) => void;
  "doctor:check": (payload: CheckResult) => void;
};

/**
 * Creates the cli hook map. Every handler renders through `ctx.state.ui` — the single
 * branded console the state factory built from the configured render seam (N5) — and
 * `native:phase` additionally keeps the running phase's start time in
 * `ctx.state.progress`, which is what drives the spinner frame.
 *
 * @param ctx - Plugin context (shared console + progress bookkeeping in state).
 * @returns The hook map wired onto the cli plugin.
 * @example
 * ```ts
 * hooks: ctx => createCliHandlers(ctx)
 * ```
 */
export function createCliHandlers(ctx: CliContext): CliHandlers {
  const ui = ctx.state.ui;

  return {
    /**
     * Handles one `native:phase` event: stamps/clears the running phase's start time in
     * `ctx.state.progress`, then renders the corresponding status line.
     *
     * @param payload - The phase event payload.
     * @example
     * ```ts
     * handlers["native:phase"]({ target: "macos", phase: "compile", status: "start" });
     * ```
     */
    "native:phase"(payload) {
      if (payload.status === "start") ctx.state.progress = { startedAt: Date.now() };

      const elapsedMs = ctx.state.progress.startedAt
        ? Date.now() - ctx.state.progress.startedAt
        : 0;
      renderPhaseEvent(ui, payload, elapsedMs);

      if (payload.status === "done" || payload.status === "error") {
        ctx.state.progress = { startedAt: undefined };
      }
    },

    /**
     * Handles one `native:complete` event: renders the completion summary panel.
     *
     * @param payload - The completion event payload.
     * @example
     * ```ts
     * handlers["native:complete"]({ target: "macos", outPath: "dist-native/macos", artifacts: [], durationMs: 1 });
     * ```
     */
    "native:complete"(payload) {
      renderCompleteEvent(ui, payload, ctx.global.app.name);
    },

    /**
     * Handles one `doctor:check` event: renders the live pass/warn/fail row.
     *
     * @param payload - The completed check result.
     * @example
     * ```ts
     * handlers["doctor:check"]({ id: "node-binary", target: "host", status: "pass", message: "ok" });
     * ```
     */
    "doctor:check"(payload) {
      renderCheckEvent(ui, payload);
    }
  };
}
