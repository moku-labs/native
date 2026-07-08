/**
 * @file project plugin generators — shared GeneratorInput/Artifact types.
 */
import type { Config, Target } from "../../../config";
import type { ResolvedCapability } from "../types";

/**
 * Pure generator input — a frozen global config slice plus the capabilities already
 * resolved and platform-filtered for this target.
 */
export type GeneratorInput = {
  /** Frozen global framework config. */
  global: Readonly<Config>;
  /** The packaging target being generated for. */
  target: Target;
  /** Capabilities resolved from `config.system`, filtered to rows whose `platforms` include `target`. */
  capabilities: readonly ResolvedCapability[];
};

/** One pure generated file — a project-relative path (from `projectDir`) plus its full content. */
export type Artifact = {
  /** Path relative to `projectDir` (e.g. `"src-tauri/tauri.conf.json"`). */
  path: string;
  /** The full file content to write. */
  content: string;
};
