/**
 * @file doctor plugin tests — the typed `ctx.require` a mock context needs.
 */
import type { projectPlugin } from "../../../project";
import type { tauriPlugin } from "../../../tauri";
import type { DoctorContext } from "../../types";

/**
 * Builds doctor's typed `require` over a plugin-name → fake-API map. A test stubs only the
 * methods the checks under test call, so the map is `unknown`-valued and this one assertion
 * is where those fakes re-enter the typed world — the mock context itself then needs no cast.
 *
 * @param apis - Fake APIs keyed by plugin name (`project`, `tauri`).
 * @returns A `require` matching `DoctorContext["require"]`, throwing on an unexpected plugin.
 * @example
 * ```ts
 * const ctx: DoctorContext = { ...rest, require: createMockRequire({ project, tauri }) };
 * ```
 */
export function createMockRequire(
  apis: Readonly<Record<string, unknown>>
): DoctorContext["require"] {
  return <P extends typeof projectPlugin | typeof tauriPlugin>(plugin: P): P["_phantom"]["api"] => {
    const api = apis[plugin.name];
    if (api === undefined) throw new Error(`[test] unexpected ctx.require("${plugin.name}")`);
    return api as P["_phantom"]["api"];
  };
}
