/**
 * @file build plugin — per-target phase pipeline: scaffold → codegen → icons → compile →
 * bundle → collect, with timing, native:phase/native:complete emission, the mobile
 * init/completeness gate inside codegen, the icons freshness rule and the
 * live compile→bundle transition split.
 */
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { NativePhase, Target } from "../../config";
import { collectArtifacts } from "./collect";
import type { BuildContext, BuildDeps, BuildResult, PhaseTiming, RunOptions } from "./types";

/** Mobile packaging targets — the only two with a `gen/<platform>` init + completeness gate. */
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
 * gate never re-initializes a partial tree, so this points at diagnosis/reset instead
 * (`tauri#13902` can leave a partial init).
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
 * Runs the `scaffold` phase: ensures `projectDir` exists. Nothing else — the mobile
 * `gen/` tree is initialized in `codegen`, because `tauri ios|android init --ci` refuses
 * to run before `tauri.conf.json` exists on disk.
 *
 * @param ctx - The build pipeline's domain context.
 * @returns Nothing.
 * @example
 * ```ts
 * await runScaffold(ctx);
 * ```
 */
export async function runScaffold(ctx: BuildContext): Promise<void> {
  await mkdir(ctx.global.projectDir, { recursive: true });
}

/** What the codegen phase reports to the icons phase that follows it. */
export type CodegenResult = { mobileInitRan: boolean };

/**
 * Runs the `codegen` phase — `project.generate()` first (mobile init needs the generated
 * `tauri.conf.json`), then for a mobile target: `tauri.mobileInit()` when the `gen/` tree
 * is absent, the completeness gate (a partial tree fails fast, never silently
 * re-initialized), and the idempotent `project.patchMobile()` pass carrying
 * `tauri.getRunner()` — Tauri's own generated build phase calls a `node tauri` command
 * does not exist.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param target - The packaging target being generated for.
 * @returns Whether this pass initialized the mobile tree (the icons phase needs it).
 * @throws {Error} When a mobile target's `gen/` tree is present but incomplete.
 * @example
 * ```ts
 * const { mobileInitRan } = await runCodegen(ctx, deps, "ios");
 * ```
 */
export async function runCodegen(
  ctx: BuildContext,
  deps: BuildDeps,
  target: Target
): Promise<CodegenResult> {
  await deps.project.generate({ target });
  if (!isMobileTarget(target)) return { mobileInitRan: false };

  let status = deps.project.getCompleteness({ target });
  let mobileInitRan = false;
  if (status.status === "not-initialized") {
    await deps.tauri.mobileInit({ target });
    mobileInitRan = true;
    status = deps.project.getCompleteness({ target });
  }
  if (status.status === "incomplete") {
    throw incompleteMobileTreeError(target, status.missing);
  }

  await deps.project.patchMobile({ target, runner: deps.tauri.getRunner() });
  ctx.log.debug("build:codegen", { target, mobileInitRan });
  return { mobileInitRan };
}

/**
 * Reads a path's modification time, treating an absent path as "no mtime" rather than
 * an error — a missing generated icon simply means the set has to be regenerated.
 *
 * @param target - The path to stat.
 * @returns The modification time in milliseconds, or undefined when the path is absent.
 * @example
 * ```ts
 * const mtime = await modifiedAt("/app/.moku/tauri/src-tauri/icons/icon.png");
 * ```
 */
async function modifiedAt(target: string): Promise<number | undefined> {
  try {
    const stats = await stat(target);
    return stats.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Runs the `icons` phase: resolves the icon source through `project.ensureIconSource()`
 * (the configured `app.icon`, or a generated placeholder) and regenerates the full icon
 * set with `tauri.icon()`. The set is left alone ONLY when the generated
 * `src-tauri/icons/icon.png` is newer than the source AND this pass did not run
 * `mobileInit` — a fresh `gen/` tree ships Tauri's own default icons, which must be
 * overwritten.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param opts - Phase input.
 * @param opts.mobileInitRan - Whether codegen initialized the mobile tree in this pass.
 * @returns The phase detail: `"up to date"`, `"generated"` or `"placeholder"`.
 * @example
 * ```ts
 * const { detail } = await runIcons(ctx, deps, { mobileInitRan: false });
 * ```
 */
export async function runIcons(
  ctx: BuildContext,
  deps: BuildDeps,
  opts: { mobileInitRan: boolean }
): Promise<{ detail: string }> {
  const source = await deps.project.ensureIconSource();
  const generatedIcon = path.join(ctx.global.projectDir, "src-tauri", "icons", "icon.png");
  const [generatedAt, sourceAt] = await Promise.all([
    modifiedAt(generatedIcon),
    modifiedAt(source)
  ]);

  const isFresh = generatedAt !== undefined && sourceAt !== undefined && generatedAt > sourceAt;
  if (isFresh && !opts.mobileInitRan) {
    ctx.log.debug("build:icons", { action: "skipped", source });
    return { detail: "up to date" };
  }

  await deps.tauri.icon({ source });
  ctx.log.debug("build:icons", { action: "generated", source });
  return { detail: ctx.global.app.icon ? "generated" : "placeholder" };
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
 * phases (one process — D-013). The transition is LIVE: the first scrubbed output line
 * matching the bundling pattern closes `compile` and opens `bundle` right then, so a
 * progress UI never sits on "compiling" through the whole bundling step. When no
 * transition line ever appears, `compile` closes at exit and `bundle` is reported as a
 * zero-duration pass. A failure is attributed to whichever phase is open.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param opts - The target plus the platform build flags to forward.
 * @returns The measured `compile` and `bundle` phase durations.
 * @throws {Error} Whatever `tauri.build()` throws (already reported via native:phase).
 * @example
 * ```ts
 * const { compileDurationMs } = await runCompileAndBundle(ctx, deps, { target: "macos" });
 * ```
 */
export async function runCompileAndBundle(
  ctx: BuildContext,
  deps: BuildDeps,
  opts: RunOptions
): Promise<{ compileDurationMs: number; bundleDurationMs: number }> {
  const { target } = opts;
  const startedAt = Date.now();
  let transitionAt: number | undefined;

  emitPhase(ctx, target, "compile", "start");
  try {
    await deps.tauri.build({
      target,
      simulator: opts.simulator,
      aab: opts.aab,
      exportMethod: ctx.global.signing.apple?.exportMethod,
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
       * Closes `compile` and opens `bundle` the moment the subprocess reports it started
       * bundling — while it is still running.
       *
       * @param line - A single scrubbed output line.
       * @example
       * ```ts
       * onOutput("Bundling application (App.dmg)");
       * ```
       */
      onOutput: line => {
        if (transitionAt !== undefined) return;
        if (!BUNDLING_TRANSITION_PATTERN.test(line)) return;
        transitionAt = Date.now();
        emitPhase(ctx, target, "compile", "done", { durationMs: transitionAt - startedAt });
        emitPhase(ctx, target, "bundle", "start");
      }
    });
  } catch (error) {
    // The failure belongs to whichever phase is still open when the subprocess dies.
    const openPhase: NativePhase = transitionAt === undefined ? "compile" : "bundle";
    const detail = error instanceof Error ? error.message : String(error);
    emitPhase(ctx, target, openPhase, "error", {
      durationMs: Date.now() - (transitionAt ?? startedAt),
      detail
    });
    throw error;
  }

  const endedAt = Date.now();
  if (transitionAt === undefined) {
    const compileDurationMs = endedAt - startedAt;
    emitPhase(ctx, target, "compile", "done", { durationMs: compileDurationMs });
    emitPhase(ctx, target, "bundle", "start");
    emitPhase(ctx, target, "bundle", "done", { durationMs: 0 });
    return { compileDurationMs, bundleDurationMs: 0 };
  }

  const bundleDurationMs = endedAt - transitionAt;
  emitPhase(ctx, target, "bundle", "done", { durationMs: bundleDurationMs });
  return { compileDurationMs: transitionAt - startedAt, bundleDurationMs };
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
 * const { durationMs } = await runPhase(ctx, "macos", "scaffold", () => runScaffold(ctx));
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
 * Runs the three preparation phases — `scaffold → codegen → icons` — that bring the
 * generated project to a buildable state. `dev` needs exactly these: a `tauri dev`
 * run compiles from the same tree, so it must never see a stale or missing one.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param target - The packaging target to prepare for.
 * @returns The three measured phase timings, in execution order.
 * @throws {Error} Whatever the failing phase throws (already reported via native:phase).
 * @example
 * ```ts
 * await runPrepare(ctx, deps, "macos");
 * ```
 */
export async function runPrepare(
  ctx: BuildContext,
  deps: BuildDeps,
  target: Target
): Promise<readonly PhaseTiming[]> {
  const scaffold = await runPhase(ctx, target, "scaffold", () => runScaffold(ctx));
  const codegen = await runPhase(ctx, target, "codegen", () => runCodegen(ctx, deps, target));
  const icons = await runPhase(
    ctx,
    target,
    "icons",
    () => runIcons(ctx, deps, { mobileInitRan: codegen.result.mobileInitRan }),
    result => result.detail
  );

  return [
    { phase: "scaffold", durationMs: scaffold.durationMs },
    { phase: "codegen", durationMs: codegen.durationMs },
    { phase: "icons", durationMs: icons.durationMs }
  ];
}

/**
 * Runs the full `scaffold → codegen → icons → compile → bundle → collect` pipeline for
 * ONE target — sequential phases, each timed and reported via `native:phase`, stopping at
 * the first failing phase. Emits `native:complete` on success.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param opts - The target plus the platform build flags (`simulator`, `aab`).
 * @returns The completed pipeline's result, with all six phase timings.
 * @throws {Error} Whatever the failing phase throws (already reported via native:phase).
 * @example
 * ```ts
 * const result = await runPipeline(ctx, deps, { target: "macos" });
 * ```
 */
export async function runPipeline(
  ctx: BuildContext,
  deps: BuildDeps,
  opts: RunOptions
): Promise<BuildResult> {
  const { target } = opts;
  const startedAt = Date.now();

  const phases: PhaseTiming[] = [...(await runPrepare(ctx, deps, target))];

  const { compileDurationMs, bundleDurationMs } = await runCompileAndBundle(ctx, deps, opts);
  phases.push(
    { phase: "compile", durationMs: compileDurationMs },
    { phase: "bundle", durationMs: bundleDurationMs }
  );

  const collect = await runPhase(ctx, target, "collect", () =>
    collectArtifacts(
      ctx.global.projectDir,
      target,
      ctx.global.outDir,
      deps.project.getBundleLayout({ target }),
      { simulator: opts.simulator, aab: opts.aab }
    )
  );
  phases.push({ phase: "collect", durationMs: collect.durationMs });

  const durationMs = Date.now() - startedAt;
  const { outPath, artifacts } = collect.result;
  ctx.emit("native:complete", { target, outPath, artifacts, durationMs });

  return { target, outPath, artifacts, durationMs, phases };
}
