/**
 * @file cli plugin — state factory.
 */
import type { State } from "./types";

/**
 * Creates initial cli render-progress state.
 *
 * @returns Fresh progress bookkeeping with no active phase.
 * @example
 * ```ts
 * const state = createCliState();
 * ```
 */
export function createCliState(): State {
  return { progress: { phase: undefined, startedAt: undefined, ticks: 0 } };
}
