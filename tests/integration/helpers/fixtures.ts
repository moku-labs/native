/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/SpawnFn result
   shapes (`signal: string | null`, `code: number | null`), which stay `| null` per spec/02's
   Node-mirroring reconciliation (matches build/cli/doctor/tauri's own tests). */
/**
 * @file Shared spawn/probe fakes for the root integration test wave — the single source of
 * subprocess/probe fixture shapes for all five `tests/integration/*.test.ts` files. Verbatim
 * idioms from the plugin integration tests (`src/plugins/build|cli|doctor/__tests__/integration/`).
 * No vitest imports here — scenarios own their spies; these are plain closures.
 */
import type { Doctor, Tauri } from "../../../src/index";

/**
 * A fake `tauri build` subprocess: emits a compile-tick line then a bundling-transition
 * line before resolving successfully (code 0).
 *
 * @param opts - The SpawnFn options; `opts.onLine` receives the two progress lines.
 * @returns A resolved success result (`code: 0`, stdout `"built"`).
 * @example
 * ```ts
 * const { app } = await createTestApp({ spawnImpl: spawnBuildSucceeds });
 * ```
 */
export const spawnBuildSucceeds: Tauri.SpawnFn = async opts => {
  opts.onLine?.("[1/1] Compiling demo v0.1.0");
  opts.onLine?.("Bundling application (App.dmg)");
  return { code: 0, signal: null, stdout: "built", stderr: "" };
};

/**
 * A fake dev subprocess that emits a readiness-looking line then exits cleanly (code 0).
 *
 * @param opts - The SpawnFn options; `opts.onLine` receives the dev-server local URL line.
 * @returns A resolved success result (`code: 0`).
 * @example
 * ```ts
 * const { app } = await createTestApp({ spawnImpl: spawnDevExitsZero });
 * await app.cli.dev(); // resolves once the fake process exits
 * ```
 */
export const spawnDevExitsZero: Tauri.SpawnFn = async opts => {
  opts.onLine?.("Local:   http://localhost:5173/");
  return { code: 0, signal: null, stdout: "", stderr: "" };
};

/**
 * A fake dev subprocess that exits non-zero (simulating a crashed dev server).
 *
 * @returns A resolved failure result (`code: 1`, stderr `"boom"`).
 * @example
 * ```ts
 * const { app } = await createTestApp({ spawnImpl: spawnDevFails });
 * await expect(app.cli.dev()).rejects.toThrow(/tauri dev exited/);
 * ```
 */
export const spawnDevFails: Tauri.SpawnFn = async () => ({
  code: 1,
  signal: null,
  stdout: "",
  stderr: "boom"
});

/**
 * Builds a spawn fake that always exits non-zero with the given stderr — e.g. a
 * signing-flavored failure for TauriError-classification scenarios (S18a).
 *
 * @param stderr - The stderr text the fake subprocess reports.
 * @returns A SpawnFn resolving `code: 1` with the given stderr.
 * @example
 * ```ts
 * const spawnImpl = spawnFailsWith("failed to sign app: no identity found");
 * ```
 */
export function spawnFailsWith(stderr: string): Tauri.SpawnFn {
  return async () => ({ code: 1, signal: null, stdout: "", stderr });
}

/**
 * Routes spawn call N to `fns[N]`; once the list is exhausted, the last fake repeats.
 * Use for succeed-then-fail choreography (S06) or argv-dependent sequences (S07).
 *
 * @param fns - The spawn fakes to route to, in call order (at least one).
 * @returns A SpawnFn that dispatches each successive call to the next fake.
 * @example
 * ```ts
 * const spawnImpl = spawnSequence(spawnBuildSucceeds, spawnFailsWith("error: build failed"));
 * ```
 */
export function spawnSequence(...fns: Tauri.SpawnFn[]): Tauri.SpawnFn {
  let callIndex = 0;

  return opts => {
    // Route call N to fns[N]; past the end, the last fake repeats.
    const fn = fns[Math.min(callIndex, fns.length - 1)];
    callIndex += 1;

    if (!fn) return Promise.reject(new Error("spawnSequence: no spawn fakes provided"));
    return fn(opts);
  };
}

/**
 * A probe fake that succeeds every binary presence/version probe doctor issues.
 * `rustup` probes answer with an installed target triple; everything else answers `"ok"`.
 *
 * @param cmd - The probed command name.
 * @returns A resolved probe result (`code: 0`).
 * @example
 * ```ts
 * const { app } = await createTestApp({ probeImpl: probeAlwaysOk });
 * ```
 */
export const probeAlwaysOk: Doctor.ProbeFn = async cmd => probeOkResult(cmd);

/**
 * The shared all-ok probe answer — `rustup` reports an installed target triple.
 *
 * @param cmd - The probed command name.
 * @returns A success probe result (`code: 0`).
 */
function probeOkResult(cmd: string): { code: number; stdout: string } {
  return { code: 0, stdout: cmd === "rustup" ? "aarch64-apple-darwin" : "ok" };
}

/**
 * Builds a probe fake that FAILS (`code: 1`) for the listed commands and answers like
 * {@link probeAlwaysOk} for everything else.
 *
 * @param cmds - Command names whose probes report failure.
 * @returns A ProbeFn failing only the listed commands.
 * @example
 * ```ts
 * const probeImpl = probeFailFor(["rustup"]);
 * ```
 */
export function probeFailFor(cmds: readonly string[]): Doctor.ProbeFn {
  return async cmd => {
    if (cmds.includes(cmd)) return { code: 1, stdout: "" };
    return probeOkResult(cmd);
  };
}

/**
 * Builds a probe fake that REJECTS (throws — not a non-zero exit) for the listed commands
 * and answers like {@link probeAlwaysOk} for everything else. Exercises doctor's
 * allSettled resilience (S19b): a rejection maps to an internal-error CheckResult.
 *
 * @param cmds - Command names whose probes reject.
 * @returns A ProbeFn rejecting only the listed commands.
 * @example
 * ```ts
 * const probeImpl = probeRejectFor(["rustup"]);
 * const report = await app.doctor.run(); // still resolves; report.ok === false
 * ```
 */
export function probeRejectFor(cmds: readonly string[]): Doctor.ProbeFn {
  return async cmd => {
    if (cmds.includes(cmd)) throw new Error(`probe rejected: ${cmd}`);
    return probeOkResult(cmd);
  };
}
