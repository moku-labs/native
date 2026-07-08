/**
 * @file tauri plugin — line splitting + compile-tick parsing (pure, best-effort).
 *
 * `stdout`/`stderr` ordering across cargo/tauri subprocess output is NOT
 * guaranteed, so tick parsing is best-effort logging/progress only — never a
 * state-machine trigger (spec/02 §Domain Files).
 */
import type { CompileTick } from "./types";

/** Result of pushing a chunk through the line splitter. */
export type SplitResult = {
  /** Complete lines extracted from `buffer + chunk`. */
  readonly lines: readonly string[];
  /** Trailing partial line, carried over to the next chunk. */
  readonly buffer: string;
};

/**
 * Splits a streamed chunk into complete lines, carrying over a trailing
 * partial line for the next call. Pure — the caller owns the buffer state.
 *
 * @param buffer - Leftover partial line from the previous chunk (`""` initially).
 * @param chunk - Newly received chunk of subprocess output.
 * @returns The complete lines found, plus the new trailing buffer.
 * @example
 * ```ts
 * let buffer = "";
 * const { lines, buffer: next } = splitLines(buffer, "Compiling foo\nCompi");
 * // lines: ["Compiling foo"], next: "Compi"
 * buffer = next;
 * ```
 */
export function splitLines(buffer: string, chunk: string): SplitResult {
  const combined = buffer + chunk;
  const parts = combined.split(/\r?\n/);
  const trailing = parts.pop() ?? "";
  return { lines: parts, buffer: trailing };
}

// Not start-anchored: cargo unit progress prefixes ("[N/M] Compiling ...") put the
// bracketed counter BEFORE "Compiling" on the same line.
const COMPILING_PATTERN = /Compiling\s+(\S+)(?:\s+v[\w.+-]+)?/;
const PROGRESS_PATTERN = /^\s*\[\s*(\d+)\/(\d+)\s*\]/;

/**
 * Parses a single output line into a {@link CompileTick} — real crate counts
 * (`"Compiling <crate> vX"`, optionally prefixed with cargo `[N/M]` unit
 * progress) — never a fake/synthesized percentage.
 *
 * @param line - A single, already-split output line.
 * @returns The parsed tick, or `undefined` when the line isn't compile progress.
 * @example
 * ```ts
 * parseCompileTick("   Compiling serde v1.0.190"); // { crate: "serde" }
 * parseCompileTick("[3/50] Compiling tauri v2.0.0"); // { crate: "tauri", index: 3, total: 50 }
 * ```
 */
export function parseCompileTick(line: string): CompileTick | undefined {
  const compilingMatch = COMPILING_PATTERN.exec(line);
  const crate = compilingMatch?.[1];
  if (!crate) return undefined;

  const progressMatch = PROGRESS_PATTERN.exec(line);
  if (progressMatch?.[1] !== undefined && progressMatch[2] !== undefined) {
    return { crate, index: Number(progressMatch[1]), total: Number(progressMatch[2]) };
  }
  return { crate };
}
