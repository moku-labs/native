/**
 * @file build plugin — the shared `compile`/`bundle` step: one `tauri build` subprocess with
 * the live compile→bundle transition split, the iOS build-output clear, and the built-tree
 * checks before anything is collected.
 */
import path from "node:path";
import type { BuildProfile, NativePhase, Target } from "../../config";
import { emitPhase, profileOf } from "./phase";
import type { BuildContext, BuildDeps, RunOptions } from "./types";

/**
 * Builds the refusal for a store build whose page carries the editor agent (Decision D7).
 *
 * @param dist - The configured `web.dist`.
 * @param file - The agent file, relative to the dist, when the scan named one.
 * @returns A formatted `[native] ...` error.
 * @example
 * ```ts
 * throw storeAgentRefusal("dist", "page/main-4f2a.js");
 * ```
 */
function storeAgentRefusal(dist: string, file: string | undefined): Error {
  const where = file === undefined ? dist : path.posix.join(dist, file);
  return new Error(
    `[native] store build refused: the page carries the editor agent (${where}).\n  Build with debug: true.`
  );
}

/**
 * The checks at the end of compile/bundle, before anything is collected: on android the
 * shell link (the project plugin decides whether the profile composes the shell), then the
 * page — a store build whose page carries the editor agent is refused; a debug or dev build
 * may carry it. They run after the full compile because tauri runs the web build inside
 * `tauri build`.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param target - The packaging target that was compiled.
 * @param profile - The profile it was compiled in.
 * @returns Nothing.
 * @throws {Error} The project plugin's link error, or the store refusal.
 */
async function checkBuiltTree(
  ctx: BuildContext,
  deps: BuildDeps,
  target: Target,
  profile: BuildProfile
): Promise<void> {
  if (target === "android") await deps.project.checkShellLinked({ target, profile });
  const page = await deps.project.detectPageAgent();
  if (page.agent && profile === "store") throw storeAgentRefusal(ctx.global.web.dist, page.file);
}

/** Matches a tauri build output line signalling the compile→bundle transition. */
const BUNDLING_TRANSITION_PATTERN = /bundling/i;

/** Compile-phase detail reported when a previous build's output had to be removed first. */
const CLEARED_BUILD_OUTPUT_DETAIL = "cleared previous build output";

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

/** The measured durations of the shared `compile`/`bundle` subprocess. */
type CompileAndBundleTimings = { compileDurationMs: number; bundleDurationMs: number };

/**
 * The iOS step that opens `compile`: removes the previous build's output before the
 * compiler starts, and reports it as compile progress when something was removed. Any other
 * target is left alone.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param target - The packaging target being compiled.
 * @returns Nothing.
 * @throws {Error} The project plugin's refusal from the guarded remove.
 */
async function clearIosBuildOutput(
  ctx: BuildContext,
  deps: BuildDeps,
  target: Target
): Promise<void> {
  if (target !== "ios") return;
  const cleared = await deps.project.clearMobileBuildOutput({ target });
  if (cleared.removed.length > 0) {
    emitPhase(ctx, target, "compile", "progress", { detail: CLEARED_BUILD_OUTPUT_DETAIL });
  }
}

/**
 * Closes the phases still open after a successful subprocess and measures both. With a live
 * transition only `bundle` is open; without one `compile` closes now and `bundle` is
 * reported as a zero-duration pass.
 *
 * @param ctx - The build pipeline's domain context.
 * @param target - The packaging target that was compiled.
 * @param marks - Monotonic readings of the run.
 * @param marks.startedAt - When `compile` opened.
 * @param marks.transitionAt - When `bundle` opened, or undefined when no transition line came.
 * @param marks.endedAt - When the subprocess and the built-tree checks finished.
 * @returns The measured `compile` and `bundle` durations.
 */
function reportCompileAndBundleDone(
  ctx: BuildContext,
  target: Target,
  marks: { startedAt: number; transitionAt: number | undefined; endedAt: number }
): CompileAndBundleTimings {
  const { startedAt, transitionAt, endedAt } = marks;
  if (transitionAt === undefined) {
    const compileDurationMs = Math.round(endedAt - startedAt);
    emitPhase(ctx, target, "compile", "done", { durationMs: compileDurationMs });
    emitPhase(ctx, target, "bundle", "start");
    emitPhase(ctx, target, "bundle", "done", { durationMs: 0 });
    return { compileDurationMs, bundleDurationMs: 0 };
  }

  const bundleDurationMs = Math.round(endedAt - transitionAt);
  emitPhase(ctx, target, "bundle", "done", { durationMs: bundleDurationMs });
  return { compileDurationMs: Math.round(transitionAt - startedAt), bundleDurationMs };
}

/**
 * Runs the shared `tauri build` subprocess that covers BOTH the `compile` and `bundle`
 * phases (one process — D-013). The transition is LIVE: the first scrubbed output line
 * matching the bundling pattern closes `compile` and opens `bundle` right then, so a
 * progress UI never sits on "compiling" through the whole bundling step. When no
 * transition line ever appears, `compile` closes at exit and `bundle` is reported as a
 * zero-duration pass. A failure is attributed to whichever phase is open.
 *
 * iOS opens with one extra step: the previous build's output is removed before the
 * compiler starts. `tauri ios build` renames its fresh `.app` into the existing
 * `gen/apple/build` archive and fails the SECOND build of the same tree with
 * `Directory not empty`. Removing it is part of compile, so a refusal from the guarded
 * remove surfaces as a compile error rather than an unattributed throw.
 *
 * The run's profile reaches the engine's web build as `MOKU_NATIVE_PROFILE` in the spawned
 * tauri CLI's environment. After the subprocess, still inside the open phase, the built tree
 * is checked ({@link checkBuiltTree}): a failing check is that phase's error, and nothing
 * is collected.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param opts - The target plus the platform build flags to forward.
 * @returns The measured `compile` and `bundle` phase durations.
 * @throws {Error} Whatever `tauri.build()` or the built-tree checks throw (already reported
 *   via native:phase).
 */
export async function runCompileAndBundle(
  ctx: BuildContext,
  deps: BuildDeps,
  opts: RunOptions
): Promise<CompileAndBundleTimings> {
  const { target } = opts;
  const profile = profileOf(opts);
  // Monotonic readings: a wall-clock step (NTP) must never yield a negative duration.
  const startedAt = performance.now();
  let transitionAt: number | undefined;

  emitPhase(ctx, target, "compile", "start");
  try {
    // Inside the try: a refused remove is a compile error, not an unattributed throw.
    await clearIosBuildOutput(ctx, deps, target);

    // One subprocess for both phases; its output drives the live compile→bundle switch.
    await deps.tauri.build({
      target,
      simulator: opts.simulator,
      aab: opts.aab,
      exportMethod: ctx.global.signing.apple?.exportMethod,
      env: { MOKU_NATIVE_PROFILE: profile },
      /**
       * Forwards one parsed compile tick as a `native:phase` "progress" event — until the
       * bundle phase opens, after which a "compiling" line would contradict the open phase.
       *
       * @param tick - The parsed compile tick.
       */
      onTick: tick => {
        if (transitionAt !== undefined) return;
        emitPhase(ctx, target, "compile", "progress", { detail: formatCompileTickDetail(tick) });
      },
      /**
       * Closes `compile` and opens `bundle` the moment the subprocess reports it started
       * bundling — while it is still running.
       *
       * @param line - A single scrubbed output line.
       */
      onOutput: line => {
        if (transitionAt !== undefined) return;
        if (!BUNDLING_TRANSITION_PATTERN.test(line)) return;
        transitionAt = performance.now();
        emitPhase(ctx, target, "compile", "done", {
          durationMs: Math.round(transitionAt - startedAt)
        });
        emitPhase(ctx, target, "bundle", "start");
      }
    });

    // Still inside the open phase: a failing built-tree check is that phase's error.
    await checkBuiltTree(ctx, deps, target, profile);
  } catch (error) {
    // The failure belongs to whichever phase is still open when the subprocess dies.
    const openPhase: NativePhase = transitionAt === undefined ? "compile" : "bundle";
    const detail = error instanceof Error ? error.message : String(error);
    emitPhase(ctx, target, openPhase, "error", {
      durationMs: Math.round(performance.now() - (transitionAt ?? startedAt)),
      detail
    });
    throw error;
  }

  // Success: close what is still open and report both durations.
  return reportCompileAndBundleDone(ctx, target, {
    startedAt,
    transitionAt,
    endedAt: performance.now()
  });
}
