/**
 * @file build plugin — type definitions.
 */
import type { NativePhase, Target } from "../../config";

/** Result of one target's full pipeline pass. */
export type BuildResult = {
  target: Target;
  outPath: string;
  artifacts: readonly string[];
  durationMs: number;
  phases: ReadonlyArray<{ phase: NativePhase; durationMs: number }>;
};

/** Public API of the build plugin — the per-target pipeline orchestrator. */
export type Api = {
  run(opts: { target: Target }): Promise<BuildResult>;
  runAll(opts?: { targets?: readonly Target[] }): Promise<readonly BuildResult[]>;
};
