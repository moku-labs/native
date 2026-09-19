/**
 * @file build plugin — per-target phase pipeline: scaffold → codegen → icons → compile →
 * bundle → collect, with timing, native:phase/native:complete emission, the mobile
 * scaffold gate, and the compile/bundle single-subprocess split (spec/03 §Phase semantics).
 */
import { mkdir } from "node:fs/promises";
import type { NativePhase, Target } from "../../config";
import { projectPlugin } from "../project";
import { tauriPlugin } from "../tauri";
import { collectArtifacts } from "./collect";
import type { BuildContext, BuildResult } from "./types";

/** Mobile packaging targets — the only two with a `gen/<platform>` scaffold gate. */
const MOBILE_TARGETS: ReadonlySet<Target> = new Set(["ios", "android"]);

/**
 * Narrows a packaging target to a mobile platform.
 *
 * @param target - The packaging target to check.
 * @returns Whether `target` is a mobile platform (`ios` or `android`).
 * @example
 * ```ts
 * isMobileTarget("android"); // true
 * ```
 */
function isMobileTarget(target: Target): target is "ios" | "android" {
  return MOBILE_TARGETS.has(target);
}

/**
 * Builds the `[native]`-formatted fix-it error for a partial mobile `gen/` tree — the
 * scaffold gate never re-initializes a partial tree, so this points at diagnosis/reset
 * instead (S4 refinement: `tauri#13902` can leave a partial init).
 *
 * @param target - The mobile target whose tree is incomplete.
 * @param missing - The required files/directories that are absent.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw incompleteMobileTreeError("android", ["build.gradle.kts"]);
 * ```
 */
function incompleteMobileTreeError(target: Target, missing: readonly string[]): Error {
  return new Error(
    `[native] ${target} project tree is incomplete.\n  Missing ${missing.join(", ")} — run \`native doctor\` to diagnose, or \`native clean --target ${target}\` to reset before rebuilding.`
  );
}

/**
 * Runs the `scaffold` phase. Desktop targets only ensure `projectDir` exists; mobile
 * targets gate on `project.completeness()` — a `"not-initialized"` tree is initialized
 * once via `tauri.mobileInit()` and re-checked, but a partial (`"incomplete"`) tree fails
 * fast, before any further subprocess runs, rather than being silently re-initialized.
 *
 * @param ctx - The build pipeline's domain context.
 * @param target - The packaging target being scaffolded.
 * @returns Nothing.
 * @throws {Error} When a mobile target's `gen/` tree is present but incomplete.
 * @example
 * ```ts
 * await runScaffold(ctx, "android");
 * ```
 */
export async function runScaffold(ctx: BuildContext, target: Target): Promise<void> {
  if (!isMobileTarget(target)) {
    await mkdir(ctx.global.projectDir, { recursive: true });
    return;
  }

  const project = ctx.require(projectPlugin);
  let status = project.completeness({ target });
  if (status.status === "not-initialized") {
    await ctx.require(tauriPlugin).mobileInit({ target });
    status = project.completeness({ target });
  }
  if (status.status === "incomplete") {
    throw incompleteMobileTreeError(target, status.missing);
  }
}

/**
 * Runs the `codegen` phase — `project.generate()`, plus the idempotent
 * `project.patchMobile()` pass (Android signing state only, re-applied every build; D-012)
 * for mobile targets.
 *
 * @param ctx - The build pipeline's domain context.
 * @param target - The packaging target being generated for.
 * @returns Nothing.
 * @example
 * ```ts
 * await runCodegen(ctx, "macos");
 * ```
 */
export async function runCodegen(ctx: BuildContext, target: Target): Promise<void> {
  const project = ctx.require(projectPlugin);
  await project.generate({ target });
  if (isMobileTarget(target)) {
    await project.patchMobile({ target });
  }
}

/**
 * Runs the `icons` phase. v1 wires no icon-source config field on any plugin's `Config`,
 * so there is nothing to regenerate `tauri icon` from — always reports `"skipped"` rather
 * than guessing a source path or invoking the CLI without one.
 *
 * @returns The phase detail to attach to the `native:phase` "done" event.
 * @example
 * ```ts
 * const { detail } = await runIcons();
 * ```
 */
export function runIcons(): Promise<{ detail: string }> {
  return Promise.resolve({ detail: "skipped" });
}

/** Matches a tauri build output line signalling the compile→bundle transition. */
const BUNDLING_TRANSITION_PATTERN = /bundling/i;

/**
 * Formats a compile tick into the `native:phase` "progress" detail string — real crate
 * counts, never a fake percentage.
 *
 * @param tick - The parsed compile tick.
 * @param tick.crate - The crate currently compiling.
 * @param tick.index - The crate's position in the current compile unit count, if known.
 * @param tick.total - The total compile unit count, if known.
 * @returns The human-readable progress detail.
 * @example
 * ```ts
 * formatCompileTickDetail({ crate: "tauri", index: 3, total: 50 }); // "Compiling tauri 3/50"
 * ```
 */
function formatCompileTickDetail(tick: { crate: string; index?: number; total?: number }): string {
  const counter =
    tick.index !== undefined && tick.total !== undefined ? ` ${tick.index}/${tick.total}` : "";
  return `Compiling ${tick.crate}${counter}`;
}

/**
 * Emits one `native:phase` event, omitting `durationMs`/`detail` when absent rather than
 * assigning `undefined` (D-014, `exactOptionalPropertyTypes`).
 *
 * @param ctx - The build pipeline's domain context.
 * @param target - The packaging target the phase runs for.
 * @param phase - Which pipeline phase this event reports on.
 * @param status - The phase's current status.
 * @param extra - Optional duration/detail to attach.
 * @param extra.durationMs - Elapsed time for a "done"/"error" event.
 * @param extra.detail - Human-readable detail (progress ticks, skip reasons, error text).
 * @example
 * ```ts
 * emitPhase(ctx, "macos", "scaffold", "start");
 * ```
 */
function emitPhase(
  ctx: BuildContext,
  target: Target,
  phase: NativePhase,
  status: "start" | "progress" | "done" | "error",
  extra?: { durationMs?: number; detail?: string }
): void {
  ctx.emit("native:phase", {
    target,
    phase,
    status,
    ...(extra?.durationMs === undefined ? {} : { durationMs: extra.durationMs }),
    ...(extra?.detail === undefined ? {} : { detail: extra.detail })
  });
}

/**
 * Runs the shared `tauri build` subprocess that covers BOTH the `compile` and `bundle`
 * phases (one process — D-013). `compile` carries the live `onTick` progress stream;
 * `bundle`'s duration is derived from the first scrubbed output line matching the
 * compile→bundle transition, with a zero-duration fallback when no such line appears.
 * A failure is always attributed to `compile` (the phase that always starts first) and
 * `bundle` is never emitted at all — the same "error skips the next phase" contract the
 * generic phase runner gives every other phase.
 *
 * @param ctx - The build pipeline's domain context.
 * @param target - The packaging target being compiled/bundled.
 * @returns The measured `compile` and `bundle` phase durations.
 * @throws {Error} Whatever `tauri.build()` throws (already reported via native:phase).
 * @example
 * ```ts
 * const { compileDurationMs, bundleDurationMs } = await runCompileAndBundle(ctx, "macos");
 * ```
 */
export async function runCompileAndBundle(
  ctx: BuildContext,
  target: Target
): Promise<{ compileDurationMs: number; bundleDurationMs: number }> {
  const startedAt = Date.now();
  let transitionAt: number | undefined;

  emitPhase(ctx, target, "compile", "start");
  try {
    await ctx.require(tauriPlugin).build({
      target,
      /**
       * Forwards one parsed compile tick as a `native:phase` "progress" event.
       *
       * @param tick - The parsed compile tick.
       * @example
       * ```ts
       * onTick({ crate: "tauri", index: 3, total: 50 });
       * ```
       */
      onTick: tick => {
        emitPhase(ctx, target, "compile", "progress", { detail: formatCompileTickDetail(tick) });
      },
      /**
       * Records the first moment a scrubbed output line signals the compile→bundle
       * transition, so `bundle`'s duration can be derived after the subprocess exits.
       *
       * @param line - A single scrubbed output line.
       * @example
       * ```ts
       * onOutput("Bundling application (App.dmg)");
       * ```
       */
      onOutput: line => {
        if (transitionAt === undefined && BUNDLING_TRANSITION_PATTERN.test(line)) {
          transitionAt = Date.now();
        }
      }
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const detail = error instanceof Error ? error.message : String(error);
    emitPhase(ctx, target, "compile", "error", { durationMs, detail });
    throw error;
  }

  const endedAt = Date.now();
  const bundleStartedAt = transitionAt ?? endedAt;
  const compileDurationMs = bundleStartedAt - startedAt;
  const bundleDurationMs = endedAt - bundleStartedAt;

  emitPhase(ctx, target, "compile", "done", { durationMs: compileDurationMs });
  emitPhase(ctx, target, "bundle", "start");
  emitPhase(ctx, target, "bundle", "done", { durationMs: bundleDurationMs });

  return { compileDurationMs, bundleDurationMs };
}

/**
 * Runs one phase generically: emits `native:phase` start/done/error and measures
 * duration, rethrowing on failure so the caller stops the pipeline (no partial-continue,
 * v1) — the phase after a failing one is never started.
 *
 * @param ctx - The build pipeline's domain context.
 * @param target - The packaging target the phase runs for.
 * @param phase - Which pipeline phase this is.
 * @param run - The phase's work.
 * @param detailOf - Optional: derives the "done" event's `detail` from the phase's result.
 * @returns The measured phase duration and the phase's own return value.
 * @throws {Error} Rethrows whatever `run` throws, after emitting the error event.
 * @example
 * ```ts
 * const { durationMs } = await runPhase(ctx, "macos", "scaffold", () => runScaffold(ctx, "macos"));
 * ```
 */
async function runPhase<T>(
  ctx: BuildContext,
  target: Target,
  phase: NativePhase,
  run: () => Promise<T>,
  detailOf?: (result: T) => string | undefined
): Promise<{ durationMs: number; result: T }> {
  const startedAt = Date.now();
  emitPhase(ctx, target, phase, "start");
  try {
    const result = await run();
    const durationMs = Date.now() - startedAt;
    const detail = detailOf?.(result);
    emitPhase(
      ctx,
      target,
      phase,
      "done",
      detail === undefined ? { durationMs } : { durationMs, detail }
    );
    return { durationMs, result };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const detail = error instanceof Error ? error.message : String(error);
    emitPhase(ctx, target, phase, "error", { durationMs, detail });
    throw error;
  }
}

/**
 * Runs the full `scaffold → codegen → icons → compile → bundle → collect` pipeline for
 * ONE target — sequential phases, each timed and reported via `native:phase`, stopping at
 * the first failing phase. Emits `native:complete` on success.
 *
 * @param ctx - The build pipeline's domain context.
 * @param target - The packaging target to build.
 * @returns The completed pipeline's result.
 * @throws {Error} Whatever the failing phase throws (already reported via native:phase).
 * @example
 * ```ts
 * const result = await runPipeline(ctx, "macos");
 * ```
 */
export async function runPipeline(ctx: BuildContext, target: Target): Promise<BuildResult> {
  const startedAt = Date.now();
  const phases: Array<{ phase: NativePhase; durationMs: number }> = [];

  const scaffold = await runPhase(ctx, target, "scaffold", () => runScaffold(ctx, target));
  phases.push({ phase: "scaffold", durationMs: scaffold.durationMs });

  const codegen = await runPhase(ctx, target, "codegen", () => runCodegen(ctx, target));
  phases.push({ phase: "codegen", durationMs: codegen.durationMs });

  const icons = await runPhase(ctx, target, "icons", runIcons, result => result.detail);
  phases.push({ phase: "icons", durationMs: icons.durationMs });

  const { compileDurationMs, bundleDurationMs } = await runCompileAndBundle(ctx, target);
  phases.push(
    { phase: "compile", durationMs: compileDurationMs },
    { phase: "bundle", durationMs: bundleDurationMs }
  );

  const collect = await runPhase(ctx, target, "collect", () =>
    collectArtifacts(ctx.global.projectDir, target, ctx.global.outDir)
  );
  phases.push({ phase: "collect", durationMs: collect.durationMs });

  const durationMs = Date.now() - startedAt;
  const { outPath, artifacts } = collect.result;
  ctx.emit("native:complete", { target, outPath, artifacts, durationMs });

  return { target, outPath, artifacts, durationMs, phases };
}
