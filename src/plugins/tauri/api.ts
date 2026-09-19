/**
 * @file tauri plugin — API factory: composes resolve + argv + spawn + stream + errors + scrub + dev.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { buildArgv, devArgv, iconArgv, infoArgv, mobileInitArgv } from "./argv";
import { fetchReadinessProbe, startDev } from "./dev";
import { classify } from "./errors";
import { resolveNodePath, resolveTauriJsPath } from "./resolve";
import { scrub } from "./scrub";
import { realSpawn } from "./spawn";
import { parseCompileTick } from "./stream";
import type { Api, CompileTick, Runner, RunResult, TauriContext } from "./types";

const CLI_VERSION_PATTERN = /tauri[- ]cli[^\d]*(\d+\.\d+\.\d+)/i;

/**
 * Creates the tauri subprocess-seam API ([node, tauri.js, verb, ...] invocation — D-013).
 *
 * @param ctx - Plugin context (config seams, state, global config, log, env).
 * @returns The tauri plugin's public API.
 * @example
 * ```ts
 * const api = createTauriApi(ctx);
 * const result = await api.icon({ source: "icon.png" });
 * ```
 */
export function createTauriApi(ctx: TauriContext): Api {
  const spawnFn = ctx.config.spawnImpl ?? realSpawn;

  /**
   * Resolves the `[nodePath, tauriJsPath]` prefix shared by every verb's argv (D-013).
   *
   * @returns The resolved node binary path and tauri CLI entry path.
   * @example
   * ```ts
   * const { nodePath, tauriJsPath } = resolvePaths();
   * ```
   */
  function resolvePaths(): Runner {
    const nodePath = resolveNodePath({
      nodePath: ctx.config.nodePath,
      pathEnv: ctx.env.get("PATH")
    });
    const tauriJsPath = resolveTauriJsPath();
    return { nodePath, tauriJsPath };
  }

  /**
   * Resolves the cwd a one-shot verb runs in: the generated project root once it
   * exists, else the consumer's own cwd — `icon`/`version` legitimately run before
   * `scaffold` has created `projectDir`, and spawning into a missing directory
   * fails with a bare ENOENT instead of a `[native]` message (M11). The long-lived
   * `dev` verb is NOT covered: it always needs the generated project.
   *
   * @returns The directory the subprocess is spawned in.
   * @example
   * ```ts
   * await spawnFn({ cmd, cwd: runCwd() });
   * ```
   */
  function runCwd(): string {
    const { projectDir } = ctx.global;
    return existsSync(projectDir) ? projectDir : process.cwd();
  }

  /**
   * Runs a one-shot tauri CLI verb to completion: spawns, scrubs every output
   * line before it reaches a log/callback, and classifies a non-zero exit.
   *
   * @param cmd - The full `[nodePath, tauriJsPath, ...]` argv to spawn.
   * @param hooks - Optional per-line output/compile-tick callbacks (already scrubbed).
   * @param hooks.onOutput - Called with each scrubbed output line.
   * @param hooks.onTick - Called with each parsed compile-progress tick.
   * @returns The completed run's result.
   * @throws {Error} A classified `TauriError` on a non-zero exit.
   * @example
   * ```ts
   * await run(infoArgv(nodePath, tauriJsPath));
   * ```
   */
  async function run(
    cmd: readonly string[],
    hooks?: {
      onOutput?: ((line: string) => void) | undefined;
      onTick?: ((tick: CompileTick) => void) | undefined;
    }
  ): Promise<RunResult> {
    const startedAt = Date.now();
    /**
     * Scrubs one output line, forwards it to the caller's hooks, and parses
     * any compile-progress tick out of it.
     *
     * @param line - A single raw (unscrubbed) output line.
     * @example
     * ```ts
     * handleLine("Compiling serde v1.0.190");
     * ```
     */
    const handleLine = (line: string): void => {
      const scrubbedLine = scrub(line);
      ctx.log.debug("tauri:output", { line: scrubbedLine });
      hooks?.onOutput?.(scrubbedLine);
      const tick = parseCompileTick(scrubbedLine);
      if (tick) hooks?.onTick?.(tick);
    };

    const result = await spawnFn({ cmd, cwd: runCwd(), onLine: handleLine });
    const durationMs = Date.now() - startedAt;
    const scrubbedStdout = scrub(result.stdout);
    const scrubbedStderr = scrub(result.stderr);

    if (result.code !== 0) {
      throw classify(result.code, scrubbedStderr);
    }
    return { code: 0, stdout: scrubbedStdout, stderr: scrubbedStderr, durationMs };
  }

  return {
    /**
     * Regenerates the icon set from a source image (`tauri icon`).
     *
     * @param opts - Icon options.
     * @param opts.source - Path to the source icon image.
     * @returns The completed run's result.
     * @example
     * ```ts
     * await app.tauri.icon({ source: "assets/icon.png" });
     * ```
     */
    async icon(opts) {
      const { nodePath, tauriJsPath } = resolvePaths();
      const outputDirectory = path.resolve(ctx.global.projectDir, "src-tauri", "icons");
      return run(iconArgv(nodePath, tauriJsPath, opts.source, outputDirectory));
    },

    /**
     * Runs `tauri build` / `tauri ios|android build` for the given target,
     * streaming scrubbed output and parsed compile ticks through the callbacks.
     *
     * @param opts - Build options (target, artifact flavour, progress callbacks).
     * @param opts.target - Packaging target.
     * @param opts.simulator - iOS: build the host's simulator slice instead of a device archive.
     * @param opts.exportMethod - iOS device builds: the `--export-method` to archive with.
     * @param opts.aab - Android: emit a store bundle instead of the default installable APK.
     * @param opts.onTick - Called with parsed compile progress ("Compiling crate N/M").
     * @param opts.onOutput - Called with each scrubbed output line.
     * @returns The completed run's result.
     * @example
     * ```ts
     * await app.tauri.build({ target: "ios", simulator: true, onOutput: line => ctx.log.info(line) });
     * ```
     */
    async build(opts) {
      const { nodePath, tauriJsPath } = resolvePaths();
      return run(buildArgv(nodePath, tauriJsPath, opts), {
        onOutput: opts.onOutput,
        onTick: opts.onTick
      });
    },

    /**
     * Runs `tauri ios|android init` — the ONLY init verbs (D-013). Callers must
     * check `project.completeness()` is `"not-initialized"` before calling this.
     *
     * @param opts - Mobile init options.
     * @param opts.target - Mobile target to initialize.
     * @returns The completed run's result.
     * @example
     * ```ts
     * await app.tauri.mobileInit({ target: "ios" });
     * ```
     */
    async mobileInit(opts) {
      const { nodePath, tauriJsPath } = resolvePaths();
      return run(mobileInitArgv(nodePath, tauriJsPath, opts.target));
    },

    /**
     * Starts the long-lived dev verb (`tauri dev` / `tauri ios|android dev`).
     * Returns immediately with a live handle — never awaits `exited` itself.
     *
     * @param opts - Dev options.
     * @param opts.target - Optional packaging target (desktop-uniform when omitted).
     * @param opts.onOutput - Called with each scrubbed output line (cli renders these; defaults to log-only).
     * @returns The live dev handle.
     * @throws {Error} `[native]` when a dev session is already running.
     * @example
     * ```ts
     * const handle = await app.tauri.dev({ target: "ios" });
     * await handle.ready;
     * ```
     */
    dev(opts) {
      if (ctx.state.dev) {
        return Promise.reject(
          new Error(
            "[native] tauri dev already running.\n  Call stop() on the existing dev handle before starting another."
          )
        );
      }
      const { nodePath, tauriJsPath } = resolvePaths();
      const url = ctx.global.web.devUrl;
      /**
       * Scrubs one raw dev-process output line before it can reach any log or
       * consumer callback — the SAME pipeline posture as `run()`'s one-shot verbs.
       *
       * @param line - A single raw (unscrubbed) output line.
       * @example
       * ```ts
       * handleDevLine("Compiling app v0.1.0");
       * ```
       */
      const handleDevLine = (line: string): void => {
        const scrubbedLine = scrub(line);
        ctx.log.debug("tauri:dev:output", { line: scrubbedLine });
        opts.onOutput?.(scrubbedLine);
      };
      const handle = startDev({
        cmd: devArgv(nodePath, tauriJsPath, opts.target),
        cwd: ctx.global.projectDir,
        url,
        onLine: handleDevLine,
        deps: {
          spawn: spawnFn,
          probeReady: fetchReadinessProbe,
          intervalMs: ctx.config.readiness.intervalMs,
          timeoutMs: ctx.config.readiness.timeoutMs,
          /**
           * Installs a real process signal handler (`process.on`).
           *
           * @param event - Signal name (`SIGINT`/`SIGTERM`).
           * @param handler - Handler to install.
           * @returns The Node.js `process` object (from `process.on`).
           * @example
           * ```ts
           * onSignal("SIGINT", () => {});
           * ```
           */
          onSignal: (event, handler) => process.on(event, handler),
          /**
           * Removes a previously installed process signal handler (`process.off`).
           *
           * @param event - Signal name (`SIGINT`/`SIGTERM`).
           * @param handler - Handler to remove.
           * @returns The Node.js `process` object (from `process.off`).
           * @example
           * ```ts
           * offSignal("SIGINT", handler);
           * ```
           */
          offSignal: (event, handler) => process.off(event, handler)
        }
      });
      ctx.state.dev = handle;
      handle.exited
        .finally(() => {
          if (ctx.state.dev === handle) ctx.state.dev = undefined;
        })
        .catch(() => {
          // Swallow here — callers observe `handle.exited`/`handle.ready` directly.
        });
      return Promise.resolve(handle);
    },

    /**
     * Probes CLI presence/version via `tauri info` — used by `doctor`.
     *
     * @returns The parsed CLI version, or `null` when the CLI can't be invoked.
     * @example
     * ```ts
     * const version = await app.tauri.version();
     * ```
     */
    async version() {
      try {
        const { nodePath, tauriJsPath } = resolvePaths();
        const result = await run(infoArgv(nodePath, tauriJsPath));
        const match = CLI_VERSION_PATTERN.exec(result.stdout);
        return { cliVersion: match?.[1] ?? result.stdout.trim() };
      } catch {
        // eslint-disable-next-line unicorn/no-null -- version() contract is `{ cliVersion } | null` (spec/02); `null` is the "CLI unavailable" signal, not a lazy fallback.
        return null;
      }
    },

    /**
     * Returns the resolved `node` + `tauri.js` pair every verb spawns with, so
     * `project.patchMobile` can write the same invocation into the generated
     * Xcode/Gradle build scripts (tauri emits a bare `node tauri`, which does
     * not exist — B10).
     *
     * @returns The resolved invocation prefix.
     * @throws {Error} `[native]` when `node` or the tauri CLI cannot be resolved.
     * @example
     * ```ts
     * await app.project.patchMobile({ target: "ios", runner: app.tauri.runner() });
     * ```
     */
    runner() {
      return resolvePaths();
    }
  };
}
