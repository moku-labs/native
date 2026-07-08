/**
 * @file tauri plugin — nodePath / tauriJsPath resolution (D-013 invocation shape).
 *
 * Pure-ish and injectable: callers pass the PATH string and a `fileExists` probe
 * instead of this module reading the environment/filesystem directly, so tests
 * never touch a real PATH or a real filesystem.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/** Probe used to test whether a candidate `node` binary exists. */
export type FileExistsFn = (path: string) => boolean;

/** Options for {@link resolveNodePath}. */
export type ResolveNodePathOptions = {
  /** Explicit override (config's `nodePath`) — short-circuits the PATH walk. */
  nodePath?: string | undefined;
  /** The `PATH` environment variable value (read via `ctx.env.get("PATH")` by the caller). */
  pathEnv?: string | undefined;
  /** `process.platform`-shaped value — injectable for cross-platform tests. */
  platform?: NodeJS.Platform;
  /** Existence probe — injectable so tests never touch the real filesystem. */
  fileExists?: FileExistsFn;
};

/**
 * Resolves the real `node` binary to invoke the tauri CLI with — a PATH walk,
 * NEVER `process.execPath` (that's bun here). Never shells out to `which`/`where`.
 *
 * @param opts - Resolution options (override, PATH string, platform, fs probe).
 * @returns The resolved `node` binary path.
 * @throws {Error} `[native]` when no `node` binary is found on PATH.
 * @example
 * ```ts
 * resolveNodePath({ pathEnv: ctx.env.get("PATH") });
 * ```
 */
export function resolveNodePath(opts: ResolveNodePathOptions = {}): string {
  const {
    nodePath,
    pathEnv: pathEnvironment = "",
    platform = process.platform,
    fileExists = existsSync
  } = opts;
  if (nodePath) return nodePath;

  const isWindows = platform === "win32";
  const delimiter = isWindows ? ";" : ":";
  const separator = isWindows ? "\\" : "/";
  const binaryName = isWindows ? "node.exe" : "node";
  const directories = pathEnvironment.split(delimiter).filter(entry => entry.length > 0);

  for (const directory of directories) {
    // Joined against `platform` (not the host OS) so a POSIX test runner can still
    // exercise Windows-shaped PATH entries — `node:path.join` always uses the
    // host's separator regardless of this option.
    const trimmed = directory.endsWith(separator) ? directory.slice(0, -1) : directory;
    const candidate = `${trimmed}${separator}${binaryName}`;
    if (fileExists(candidate)) return candidate;
  }

  throw new Error(
    "[native] Could not locate a `node` binary on PATH.\n" +
      "  Install Node.js (or make sure your version manager — volta/fnm/nvm — has shimmed `node` onto PATH), then run `native doctor`."
  );
}

/** Options for {@link resolveTauriJsPath}. */
export type ResolveTauriJsPathOptions = {
  /** Injectable `require.resolve`-shaped resolver — defaults to a real one bound to this module. */
  requireResolve?: (id: string) => string;
};

/**
 * Resolves `@tauri-apps/cli/tauri.js` via `require.resolve` (never a hardcoded
 * relative path) — the framework declares `@tauri-apps/cli` as a real dependency.
 *
 * @param opts - Resolution options (injectable resolver for tests).
 * @returns The resolved path to the CLI's JS entry.
 * @throws {Error} `[native]` when the package cannot be resolved.
 * @example
 * ```ts
 * const tauriJsPath = resolveTauriJsPath();
 * ```
 */
export function resolveTauriJsPath(opts: ResolveTauriJsPathOptions = {}): string {
  const requireResolve = opts.requireResolve ?? defaultRequireResolve;
  try {
    return requireResolve("@tauri-apps/cli/tauri.js");
  } catch (error) {
    throw new Error(
      "[native] Could not resolve `@tauri-apps/cli/tauri.js`.\n" +
        "  Ensure `@tauri-apps/cli` is installed as a dependency, then run `native doctor`.",
      { cause: error }
    );
  }
}

/**
 * Default `require.resolve`-shaped resolver, bound to this module's URL.
 *
 * @param id - Module specifier to resolve.
 * @returns The resolved absolute path.
 * @example
 * ```ts
 * defaultRequireResolve("@tauri-apps/cli/tauri.js");
 * ```
 */
function defaultRequireResolve(id: string): string {
  return createRequire(import.meta.url).resolve(id);
}
