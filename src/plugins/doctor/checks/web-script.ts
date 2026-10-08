/**
 * @file doctor plugin check — web.build/web.devCommand scripts exist, resolved from the
 * SAME root Tauri will use (`web.cwd` override honored, else the consumer root).
 * Only a package-manager call (`bun run build`) names a script; a direct command is not checked.
 * Necessary-not-sufficient (documented):
 * this never executes the script, only confirms package.json declares it.
 */
import path from "node:path";
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/** The shape doctor reads out of the resolved cwd's `package.json`. */
type PackageJsonShape = {
  scripts?: Record<string, string>;
};

/**
 * Resolves the cwd Tauri will run `beforeBuildCommand`/`beforeDevCommand` from — the
 * `web.cwd` override when set (monorepo layouts), else the consumer root the packager was
 * invoked from. Never `src-tauri`: the generated tree has no `package.json` of its own.
 *
 * @param global - Frozen global framework config.
 * @returns The resolved absolute cwd.
 * @example
 * ```ts
 * resolveWebCwd(ctx.global); // "/repo/apps/web" or "/repo"
 * ```
 */
function resolveWebCwd(global: CheckInput["global"]): string {
  return path.resolve(global.web.cwd ?? ".");
}

/** Package managers whose `<pm> run <script>` (or `<pm> <script>`) names a package.json script. */
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);

/** Package-manager subcommands that run a binary, not a package.json script. */
const NON_SCRIPT_SUBCOMMANDS = new Set(["x", "exec", "dlx", "install", "add", "create"]);

/**
 * Splits a shell command into tokens, honoring single and double quotes.
 *
 * @param command - The configured shell command.
 * @returns The tokens with their quotes removed.
 * @example
 * ```ts
 * tokenize('"/opt/bin/bun" game.mjs build'); // ["/opt/bin/bun", "game.mjs", "build"]
 * ```
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

/**
 * Extracts the package.json script name a command invokes. Only a package-manager call
 * names a script: `<pm> run <script>`, or the `<pm> <script>` shorthand when the second
 * token is a bare word. Anything else is a direct command.
 *
 * @param command - The configured shell command.
 * @returns The script name, or `undefined` for a direct command.
 * @example
 * ```ts
 * extractScriptName("bun run build"); // "build"
 * ```
 */
function extractScriptName(command: string): string | undefined {
  const tokens = tokenize(command);
  const executable = path.basename(tokens[0] ?? "").replace(/\.(exe|cmd)$/i, "");
  if (!PACKAGE_MANAGERS.has(executable)) return undefined;

  const runIndex = tokens.indexOf("run");
  if (runIndex !== -1) return tokens[runIndex + 1];

  const shorthand = tokens[1];
  if (shorthand === undefined || NON_SCRIPT_SUBCOMMANDS.has(shorthand)) return undefined;
  return /^[\w:-]+$/.test(shorthand) ? shorthand : undefined;
}

/**
 * Builds the note for config keys whose command is direct, not a package script.
 *
 * @param keys - The config keys with a direct command.
 * @returns The note with a leading space, or `""` when there are none.
 * @example
 * ```ts
 * describeDirect(["web.build"]); // " web.build is a direct command, not a package script; not checked."
 * ```
 */
function describeDirect(keys: string[]): string {
  if (keys.length === 0) return "";
  if (keys.length === 1)
    return ` ${keys[0]} is a direct command, not a package script; not checked.`;
  return ` ${keys.join(" and ")} are direct commands, not package scripts; not checked.`;
}

/**
 * Confirms that `web.build`/`web.devCommand`, when they call a package script, name a
 * script present in the resolved cwd's `package.json`. A direct command is not checked.
 * Presence is necessary but not sufficient: the script itself is never executed.
 *
 * @param input - The check input (host-scoped).
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "host", fs, global, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const commands = [
    { key: "web.build", command: input.global.web.build },
    { key: "web.devCommand", command: input.global.web.devCommand }
  ].map(entry => ({ ...entry, script: extractScriptName(entry.command) }));
  const direct = commands.filter(entry => entry.script === undefined);
  const directNote = describeDirect(direct.map(entry => entry.key));

  if (direct.length === commands.length) {
    return { id: "web-script", target: "host", status: "pass", message: `[native]${directNote}` };
  }

  const cwd = resolveWebCwd(input.global);
  const packageJsonPath = path.join(cwd, "package.json");

  let raw: string;
  try {
    raw = await input.fs.readFile(packageJsonPath);
  } catch {
    return {
      id: "web-script",
      target: "host",
      status: "fail",
      message: `[native] could not read ${packageJsonPath} (resolved web.cwd).`,
      fixIt: "set config.web.cwd to your frontend project root"
    };
  }

  let scripts: Record<string, string>;
  try {
    scripts = (JSON.parse(raw) as PackageJsonShape).scripts ?? {};
  } catch {
    return {
      id: "web-script",
      target: "host",
      status: "fail",
      message: `[native] ${packageJsonPath} is not valid JSON.`,
      fixIt: `fix ${packageJsonPath}`
    };
  }

  const missing = commands
    .filter(entry => entry.script !== undefined && !(entry.script in scripts))
    .map(entry => `${entry.key} ("${entry.command}")`);

  if (missing.length > 0) {
    return {
      id: "web-script",
      target: "host",
      status: "fail",
      message: `[native] script(s) not found in ${packageJsonPath}: ${missing.join(", ")}. Presence is necessary but not sufficient — this does not run the script.${directNote}`,
      fixIt: `add the missing script(s) to ${packageJsonPath}, or update config.web to match existing scripts`
    };
  }
  return {
    id: "web-script",
    target: "host",
    status: "pass",
    message: `[native] package scripts resolved in ${packageJsonPath} (not executed).${directNote}`
  };
}

/** web.build/web.devCommand script presence — resolved from Tauri's own cwd. */
export const webScriptCheck: Check = {
  id: "web-script",
  /**
   * Whether this check applies — host-scoped only (one web build, not per target).
   *
   * @param target - The candidate scope.
   * @returns Whether `web-script` applies to `target`.
   * @example
   * ```ts
   * webScriptCheck.appliesTo("host", global); // true
   * ```
   */
  appliesTo: target => target === "host",
  run
};
