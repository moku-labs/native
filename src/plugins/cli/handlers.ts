/**
 * @file cli plugin — event hook factories (live progress rendering).
 */
import type { NativeCompleteEvent, NativePhaseEvent } from "../../config";
import type { CheckResult } from "../doctor/types";

/**
 * Hook map rendered by the cli plugin — global native:phase/native:complete plus
 * doctor:check (via depends). Placeholder shape; build replaces it with the
 * properly inferred hook map (tracked as a Skeleton Revisit item in STATE.md).
 */
export type CliHandlers = {
  "native:phase"?: (payload: NativePhaseEvent) => void | Promise<void>;
  "native:complete"?: (payload: NativeCompleteEvent) => void | Promise<void>;
  "doctor:check"?: (payload: CheckResult) => void | Promise<void>;
};

/**
 * Creates the cli hook map: native:phase + native:complete (global) and doctor:check (via depends).
 *
 * @param _ctx - Plugin context (state bookkeeping, render seam).
 * @example
 * ```ts
 * hooks: createCliHandlers
 * ```
 */
export function createCliHandlers(_ctx: unknown): CliHandlers {
  throw new Error("not implemented");
}
