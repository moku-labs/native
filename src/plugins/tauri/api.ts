/**
 * @file tauri plugin — API factory: composes resolve + argv + spawn + stream + errors + scrub + dev.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { TauriRunner } from "../../config";
import { buildArgv, devArgv, iconArgv, infoArgv, mobileInitArgv } from "./argv";
import { type DevOrchestrationDeps, fetchReadinessProbe, startDev } from "./dev";
import { classify } from "./errors";
import { resolveNodePath, resolveTauriJsPath } from "./resolve";
import { scrub } from "./scrub";
import { realSpawn } from "./spawn";
import { parseCompileTick } from "./stream";
import type { Api, CompileTick, RunResult, TauriContext } from "./types";

const CLI_VERSION_PATTERN = /tauri[- ]cli[^\d]*(\d+\.\d+\.\d+)/i;

/**
 * Creates the tauri subprocess-seam API ([node, tauri.js, verb, ...] invocation — D-013).
 *
 * @param ctx - Plugin context (config seams, state, global config, log, env).
 * @returns The tauri plugin's public API.
 */
export function createTauriApi(ctx: TauriContext): Api {
  const spawnFn = ctx.config.spawnImpl ?? realSpawn;

  /**
   * Resolves the `[nodePath, tauriJsPath]` prefix shared by every verb's argv (D-013).
   *
   * @returns The resolved node binary path and tauri CLI entry path.
   */
  function resolvePaths(): TauriRunner {
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
   * fails with a bare ENOENT instead of a `[native]` message. The long-lived
   * `dev` verb is NOT covered: it always needs the generated project.
   *
   * @returns The directory the subprocess is spawned in.
   */
  function runCwd(): string {
    const { projectDir } = ctx.global;
    return existsSync(projectDir) ? projectDir : process.cwd();
  }

  /**
   * Runs a one-shot tauri CLI verb to completion: spawns, scrubs every output
   * line before it reaches a log/callback, and classifies a non-zero exit.
   *
   * A non-zero exit is classified from BOTH scrubbed streams, never stderr alone.
   *
   * @param cmd - The full `[nodePath, tauriJsPath, ...]` argv to spawn.
   * @param hooks - Optional per-line output/compile-tick callbacks (already scrubbed) and child env.
   * @param hooks.onOutput - Called with each scrubbed output line.
   * @param hooks.onTick - Called with each parsed compile-progress tick.
   * @param hooks.env - Extra child environment; omitted, the spawn call carries no `env` key.
   * @returns The completed run's result.
   * @throws {Error} A classified `TauriError` on a non-zero exit.
   */
  async function run(
    cmd: readonly string[],
    hooks?: {
      onOutput?: ((line: string) => void) | undefined;
      onTick?: ((tick: CompileTick) => void) | undefined;
      env?: Readonly<Record<string, string>> | undefined;
    }
  ): Promise<RunResult> {
    // Monotonic reading: a wall-clock step (NTP) must never yield a negative duration.
    const startedAt = performance.now();
    /**
     * Scrubs one output line, forwards it to the caller's hooks, and parses
     * any compile-progress tick out of it.
     *
     * @param line - A single raw (unscrubbed) output line.
     */
    const handleLine = (line: string): void => {
      const scrubbedLine = scrub(line);
      ctx.log.debug("tauri:output", { line: scrubbedLine });
      hooks?.onOutput?.(scrubbedLine);
      const tick = parseCompileTick(scrubbedLine);
      if (tick) hooks?.onTick?.(tick);
    };

    // Conditional spread: with no env the call keeps its old shape — no `env: undefined` slot.
    const env = hooks?.env;
    const result = await spawnFn({
      cmd,
      cwd: runCwd(),
      onLine: handleLine,
      ...(env === undefined ? {} : { env })
    });
    const durationMs = Math.round(performance.now() - startedAt);
    const scrubbedStdout = scrub(result.stdout);
    const scrubbedStderr = scrub(result.stderr);

    if (result.code !== 0) {
      // Both streams: xcodebuild writes the real cause to stdout and leaves stderr
      // holding only tauri's one-line `failed to build with xcodebuild` wrapper.
      const scrubbedOutput = [scrubbedStdout, scrubbedStderr]
        .filter(stream => stream.length > 0)
        .join("\n");
      throw classify(result.code, scrubbedOutput);
    }
    return { code: 0, stdout: scrubbedStdout, stderr: scrubbedStderr, durationMs };
  }

  /**
   * Builds the dev-process line handler: it scrubs each raw line before the line can reach the
   * log or the caller's callback — the SAME pipeline posture as `run()`'s one-shot verbs.
   *
   * @param onOutput - The caller's per-line callback (cli renders these); log-only when omitted.
   * @returns The `onLine` handler `startDev` feeds every raw output line to.
   */
  function scrubbedDevLines(
    onOutput: ((line: string) => void) | undefined
  ): (line: string) => void {
    return line => {
      const scrubbedLine = scrub(line);
      ctx.log.debug("tauri:dev:output", { line: scrubbedLine });
      onOutput?.(scrubbedLine);
    };
  }

  /** The real process signal wiring `startDev` installs and removes its SIGINT/SIGTERM handlers with. */
  const processSignals: Pick<DevOrchestrationDeps, "onSignal" | "offSignal"> = {
    /**
     * Installs a real process signal handler (`process.on`).
     *
     * @param event - Signal name (`SIGINT`/`SIGTERM`).
     * @param handler - Handler to install.
     * @returns The Node.js `process` object (from `process.on`).
     */
    onSignal: (event, handler) => process.on(event, handler),
    /**
     * Removes a previously installed process signal handler (`process.off`).
     *
     * @param event - Signal name (`SIGINT`/`SIGTERM`).
     * @param handler - Handler to remove.
     * @returns The Node.js `process` object (from `process.off`).
     */
    offSignal: (event, handler) => process.off(event, handler)
  };

  return {
    /**
     * Implements {@link Api.icon}.
     *
     * @param opts - See {@link Api.icon}.
     * @returns See {@link Api.icon}.
     */
    async icon(opts) {
      const { nodePath, tauriJsPath } = resolvePaths();
      const outputDirectory = path.resolve(ctx.global.projectDir, "src-tauri", "icons");
      return run(iconArgv(nodePath, tauriJsPath, opts.source, outputDirectory));
    },

    /**
     * Implements {@link Api.build}.
     *
     * @param opts - See {@link Api.build}.
     * @returns See {@link Api.build}.
     */
    async build(opts) {
      const { nodePath, tauriJsPath } = resolvePaths();
      // `config.arch` is the injectable host arch: undefined lets buildArgv read process.arch.
      return run(buildArgv(nodePath, tauriJsPath, opts, ctx.config.arch), {
        onOutput: opts.onOutput,
        onTick: opts.onTick,
        env: opts.env
      });
    },

    /**
     * Implements {@link Api.mobileInit}.
     *
     * @param opts - See {@link Api.mobileInit}.
     * @returns See {@link Api.mobileInit}.
     */
    async mobileInit(opts) {
      const { nodePath, tauriJsPath } = resolvePaths();
      return run(mobileInitArgv(nodePath, tauriJsPath, opts.target));
    },

    /**
     * Implements {@link Api.dev}.
     *
     * @param opts - See {@link Api.dev}.
     * @returns See {@link Api.dev}.
     */
    dev(opts) {
      // Reject while a session is live: the one handle in state owns its teardown (D-002).
      if (ctx.state.dev) {
        return Promise.reject(
          new Error(
            "[native] tauri dev already running.\n  Call stop() on the existing dev handle before starting another."
          )
        );
      }

      // Resolve the invocation: the same [node, tauri.js] prefix the one-shot verbs spawn with.
      const { nodePath, tauriJsPath } = resolvePaths();

      // Start the session in the generated project; ready resolves from the devUrl poll.
      const handle = startDev({
        cmd: devArgv(nodePath, tauriJsPath, opts.target),
        cwd: ctx.global.projectDir,
        url: ctx.global.web.devUrl,
        onLine: scrubbedDevLines(opts.onOutput),
        deps: {
          spawn: spawnFn,
          probeReady: fetchReadinessProbe,
          intervalMs: ctx.config.readiness.intervalMs,
          timeoutMs: ctx.config.readiness.timeoutMs,
          ...processSignals
        }
      });

      // Register the handle until it exits, and park both promises: callers observe
      // `exited`/`ready` themselves, so neither may surface as an unhandled rejection here.
      ctx.state.dev = handle;
      handle.exited
        .finally(() => {
          if (ctx.state.dev === handle) ctx.state.dev = undefined;
        })
        .catch(() => {
          // Swallow here — callers observe `handle.exited`/`handle.ready` directly.
        });
      handle.ready.catch(() => {
        // Parked like `exited`: a readiness timeout (or a dev process that died first) must
        // not surface as an unhandled rejection for a caller that only awaits `exited`.
      });
      return Promise.resolve(handle);
    },

    /**
     * Implements {@link Api.getVersion}.
     *
     * @returns See {@link Api.getVersion}.
     */
    async getVersion() {
      try {
        const { nodePath, tauriJsPath } = resolvePaths();
        const result = await run(infoArgv(nodePath, tauriJsPath));
        const match = CLI_VERSION_PATTERN.exec(result.stdout);
        return { cliVersion: match?.[1] ?? result.stdout.trim() };
      } catch {
        // Absence is `undefined` (D-014): an uninvokable CLI has no version to report,
        // and a bare `return` is exactly that value.
        return;
      }
    },

    /**
     * Implements {@link Api.getRunner}.
     *
     * @returns See {@link Api.getRunner}.
     */
    getRunner() {
      return resolvePaths();
    }
  };
}
