/**
 * @file build plugin — per-target phase pipeline: scaffold → codegen → icons → compile →
 * bundle → collect, with timing, native:phase/native:complete emission, the debug-target
 * guard and the mobile init/completeness gate inside codegen. The icons phase lives in
 * `icons.ts`, the shared compile/bundle subprocess in `compile.ts`.
 */
import { mkdir } from "node:fs/promises";
import type { BuildFlavor, BuildProfile, NativePhase, Target } from "../../config";
import { collectArtifacts } from "./collect";
import { runCompileAndBundle } from "./compile";
import { runIconsPhase } from "./icons";
import { emitPhase, profileOf } from "./phase";
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
 * Refuses the debug profile for every target but android and ios (Decision D2, widened to
 * iOS by F133) — before any phase runs, and for ALL the targets of a run at once, so nothing
 * is half-built.
 *
 * @param targets - Every target the run will build.
 * @param flavor - The build flavour of the run.
 * @throws {Error} `[native] --debug builds Android and iOS only for now (asked for <target>).`
 *   for the first target that is neither, when `debug` is set.
 * @example
 * ```ts
 * assertDebugTargets(["android", "macos"], { debug: true }); // throws: asked for macos
 * ```
 */
export function assertDebugTargets(targets: readonly Target[], flavor: BuildFlavor): void {
  if (flavor.debug !== true) return;
  const refused = targets.find(target => !isMobileTarget(target));
  if (refused === undefined) return;
  throw new Error(
    `[native] --debug builds Android and iOS only for now (asked for ${refused}).\n  Build the debug profile for android or ios, or drop debug to build ${refused}.`
  );
}

/**
 * Runs the `scaffold` phase: ensures `projectDir` exists. Nothing else — the mobile
 * `gen/` tree is initialized in `codegen`, because `tauri ios|android init --ci` refuses
 * to run before `tauri.conf.json` exists on disk.
 *
 * @param ctx - The build pipeline's domain context.
 * @returns Nothing.
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
 * @param profile - The build profile generate and the patch pass apply.
 * @returns Whether this pass initialized the mobile tree (the icons phase needs it).
 * @throws {Error} When a mobile target's `gen/` tree is present but incomplete.
 */
export async function runCodegen(
  ctx: BuildContext,
  deps: BuildDeps,
  target: Target,
  profile: BuildProfile = "store"
): Promise<CodegenResult> {
  // Write the generated project first: mobile init refuses to run without its config on disk.
  await deps.project.generate({ target, profile });
  if (!isMobileTarget(target)) return { mobileInitRan: false };

  // Initialize the mobile tree when it is absent, then read its completeness again.
  let status = deps.project.getCompleteness({ target });
  let mobileInitRan = false;
  if (status.status === "not-initialized") {
    await deps.tauri.mobileInit({ target });
    mobileInitRan = true;
    status = deps.project.getCompleteness({ target });
  }

  // A partial tree fails fast: it is never silently initialized over.
  if (status.status === "incomplete") {
    throw incompleteMobileTreeError(target, status.missing);
  }

  // Point the generated build phases at the real runner and apply the profile.
  await deps.project.patchMobile({ target, runner: deps.tauri.getRunner(), profile });
  ctx.log.debug("build:codegen", { target, profile, mobileInitRan });
  return { mobileInitRan };
}

/**
 * Runs one phase generically: emits `native:phase` start/done/error and measures
 * duration (monotonic clock, whole milliseconds), rethrowing on failure so the caller
 * stops the pipeline (no partial-continue, v1) — the phase after a failing one is never
 * started.
 *
 * @param ctx - The build pipeline's domain context.
 * @param target - The packaging target the phase runs for.
 * @param phase - Which pipeline phase this is.
 * @param run - The phase's work.
 * @param detailOf - Optional: derives the "done" event's `detail` from the phase's result.
 * @returns The measured phase duration and the phase's own return value.
 * @throws {Error} Rethrows whatever `run` throws, after emitting the error event.
 */
async function runPhase<T>(
  ctx: BuildContext,
  target: Target,
  phase: NativePhase,
  run: () => Promise<T>,
  detailOf?: (result: T) => string | undefined
): Promise<{ durationMs: number; result: T }> {
  const startedAt = performance.now();
  emitPhase(ctx, target, phase, "start");
  try {
    const result = await run();
    const durationMs = Math.round(performance.now() - startedAt);
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
    const durationMs = Math.round(performance.now() - startedAt);
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
 * @param profile - The build profile codegen generates and patches for.
 * @returns The three measured phase timings, in execution order.
 * @throws {Error} Whatever the failing phase throws (already reported via native:phase).
 */
export async function runPrepare(
  ctx: BuildContext,
  deps: BuildDeps,
  target: Target,
  profile: BuildProfile = "store"
): Promise<readonly PhaseTiming[]> {
  const scaffold = await runPhase(ctx, target, "scaffold", () => runScaffold(ctx));
  const codegen = await runPhase(ctx, target, "codegen", () =>
    runCodegen(ctx, deps, target, profile)
  );
  const icons = await runPhase(
    ctx,
    target,
    "icons",
    () => runIconsPhase(ctx, deps, { target, mobileInitRan: codegen.result.mobileInitRan }),
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
 * the first failing phase. Emits `native:complete` on success, with the run's profile. A
 * debug run on any target but android and ios, and a run asking for `debug` and `dev`
 * together, are refused before the first phase.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param opts - The target plus the platform build flags (`simulator`, `aab`, `debug`, `dev`).
 * @returns The completed pipeline's result, with all six phase timings and the profile.
 * @throws {Error} Whatever the failing phase throws (already reported via native:phase), or
 *   the debug-target or `debug` + `dev` refusal (before any phase event).
 */
export async function runPipeline(
  ctx: BuildContext,
  deps: BuildDeps,
  opts: RunOptions
): Promise<BuildResult> {
  // Refuse a run no profile can build before any phase starts, then start the clock.
  const { target } = opts;
  const profile = profileOf(opts);
  assertDebugTargets([target], opts);
  const startedAt = performance.now();

  // Bring the generated project to a buildable state.
  const phases: PhaseTiming[] = [...(await runPrepare(ctx, deps, target, profile))];

  // Compile and bundle in one subprocess, recording both phase timings.
  const { compileDurationMs, bundleDurationMs } = await runCompileAndBundle(ctx, deps, opts);
  phases.push(
    { phase: "compile", durationMs: compileDurationMs },
    { phase: "bundle", durationMs: bundleDurationMs }
  );

  // Deliver the built artifacts into the output directory.
  const collect = await runPhase(ctx, target, "collect", () =>
    collectArtifacts(
      ctx.global.projectDir,
      target,
      ctx.global.outDir,
      deps.project.getBundleLayout({ target }),
      {
        simulator: opts.simulator,
        aab: opts.aab,
        debug: opts.debug,
        dev: opts.dev,
        resolvePath: deps.project.resolveDerivedPath
      }
    )
  );
  phases.push({ phase: "collect", durationMs: collect.durationMs });

  // Announce the finished delivery and hand back the full result.
  const durationMs = Math.round(performance.now() - startedAt);
  const { outPath, artifacts } = collect.result;
  ctx.emit("native:complete", { target, outPath, artifacts, durationMs, profile });
  return { target, outPath, artifacts, durationMs, phases, profile };
}
