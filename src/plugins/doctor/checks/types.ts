/**
 * @file doctor plugin — checks/ registry: shared Check interface + CheckInput (the providers
 * pattern, spec/15 §1). Every module under checks/ is a pure predicate-plus-message factory
 * over this one injected seam — never a raw subprocess/fs call of its own.
 */
import type { EnvApi } from "@moku-labs/common";
import type { Config as GlobalConfig, Target } from "../../../config";
import type { Api as ProjectApi } from "../../project/types";
import type { Api as TauriApi } from "../../tauri/types";
import type { CheckResult, ProbeFn } from "../types";

/**
 * Read-only file-read facade — assembled fresh per check run by the doctor API factory,
 * never wired through plugin `config` (unlike `probeImpl`, no consumer ever needs to
 * override this in production; tests inject a fake directly into `CheckInput`).
 */
export type FsFacade = {
  /**
   * Reads a file as UTF-8 text.
   *
   * @param path - Absolute or relative file path.
   * @returns The file's text content.
   * @throws {Error} When the file cannot be read.
   * @example
   * ```ts
   * const raw = await fs.readFile("/repo/package.json");
   * ```
   */
  readFile(path: string): Promise<string>;
};

/** The project plugin's API surface a check may read — narrowed to doctor's three needs. */
export type CheckProjectApi = Pick<
  ProjectApi,
  "getRequiredFiles" | "getCompleteness" | "getRegistryRows"
>;

/** The tauri plugin's API surface a check may read — the one probe routed through tauri (D-013). */
export type CheckTauriApi = Pick<TauriApi, "getVersion">;

/**
 * Fresh input assembled per `(check, scope)` invocation by the doctor API factory.
 * `target` is a real packaging `Target` for target-scoped checks, or the `"host"`
 * pseudo-scope for checks that run once regardless of which targets are configured.
 */
export type CheckInput = {
  /** The scope this invocation diagnoses. */
  target: Target | "host";
  /** Frozen global framework config. */
  global: Readonly<GlobalConfig>;
  /** Injectable binary presence/version probe (doctor's own seam — never tauri's). */
  probe: ProbeFn;
  /** Injectable read-only file facade. */
  fs: FsFacade;
  /** Env presence/read accessor (`ctx.env` — MC3; presence only for signing). */
  env: EnvApi;
  /** The project plugin API slice this check may call. */
  project: CheckProjectApi;
  /** The tauri plugin API slice this check may call. */
  tauri: CheckTauriApi;
};

/**
 * One diagnosis check — a pure predicate-plus-message module (spec/15 §1 providers
 * pattern). `id` doubles as the stable fallback identifier used by `report.ts` when
 * `run()` rejects (the check never got a chance to produce its own per-scope id).
 */
export type Check = {
  /** Stable check identifier (module-level; individual results may specialize it per target). */
  id: string;
  /**
   * Whether this check applies to a given scope.
   *
   * @param target - The candidate scope (a real packaging target, or "host").
   * @param global - Frozen global framework config.
   * @returns Whether this check should run for that scope.
   */
  appliesTo(target: Target | "host", global: Readonly<GlobalConfig>): boolean;
  /**
   * Runs the check for one applicable scope.
   *
   * @param input - The assembled check input for this scope.
   * @returns The completed result.
   */
  run(input: CheckInput): Promise<CheckResult>;
};
