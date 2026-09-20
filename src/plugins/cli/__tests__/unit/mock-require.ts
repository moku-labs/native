/**
 * @file cli plugin tests — the typed `ctx.require` a mock context needs.
 */
import type { buildPlugin } from "../../../build";
import type { doctorPlugin } from "../../../doctor";
import type { projectPlugin } from "../../../project";
import type { tauriPlugin } from "../../../tauri";
import type { CliContext } from "../../types";

/**
 * Builds cli's typed `require` over a plugin-name → fake-API map. A test stubs only the
 * methods its scenario actually drives, so the map is `unknown`-valued and this one
 * assertion is where those fakes re-enter the typed world — the mock context itself then
 * needs no cast at all.
 *
 * @param apis - Fake APIs keyed by plugin name (`project`, `tauri`, `build`, `doctor`).
 * @returns A `require` matching `CliContext["require"]`, throwing on an unexpected plugin.
 * @example
 * ```ts
 * const ctx: CliContext = { ...rest, require: createMockRequire({ build: buildMock }) };
 * ```
 */
export function createMockRequire(apis: Readonly<Record<string, unknown>>): CliContext["require"] {
  return <
    P extends typeof projectPlugin | typeof tauriPlugin | typeof buildPlugin | typeof doctorPlugin
  >(
    plugin: P
  ): P["_phantom"]["api"] => {
    const api = apis[plugin.name];
    if (api === undefined) throw new Error(`[test] unexpected ctx.require("${plugin.name}")`);
    return api as P["_phantom"]["api"];
  };
}
