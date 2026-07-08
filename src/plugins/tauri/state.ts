/**
 * @file tauri plugin — state factory.
 */
import type { State } from "./types";

/**
 * Creates initial tauri plugin state (no live dev session).
 *
 * @returns Fresh state with no live dev handle.
 * @example
 * ```ts
 * const state = createTauriState();
 * ```
 */
export function createTauriState(): State {
  return { dev: undefined };
}
