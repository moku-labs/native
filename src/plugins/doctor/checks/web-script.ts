/**
 * @file doctor plugin check — web.build/web.devCommand scripts exist, resolved from the
 * SAME cwd Tauri will use (web.cwd override honored). Necessary-not-sufficient (documented):
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
 * `web.cwd` override when set (monorepo layouts), else the directory containing the
 * generated `tauri.conf.json` (`<projectDir>/src-tauri`).
 *
 * @param global - Frozen global framework config.
 * @returns The resolved absolute cwd.
 * @example
 * ```ts
 * resolveWebCwd(ctx.global); // "/repo/apps/web" or "/repo/.moku/tauri/src-tauri"
 * ```
 */
function resolveWebCwd(global: CheckInput["global"]): string {
  return global.web.cwd ? path.resolve(global.web.cwd) : path.join(global.projectDir, "src-tauri");
}

/**
 * Extracts the package.json script name a command invokes (`"bun run build"` → `"build"`,
 * `"npm test"` → `"test"`). Best-effort — the command may not follow this shape.
 *
 * @param command - The configured shell command.
 * @returns The extracted script name, or `undefined` if it can't be determined.
 * @example
 * ```ts
 * extractScriptName("bun run build"); // "build"
 * ```
 */
function extractScriptName(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  const runIndex = tokens.indexOf("run");
  return runIndex === -1 ? tokens[1] : tokens[runIndex + 1];
}

/**
 * Confirms `web.build`/`web.devCommand` name scripts present in the resolved cwd's
 * `package.json`. Presence is necessary but not sufficient — the script itself is never
 * executed by this check.
 *
 * @param input - The check input (host-scoped).
 * @returns The check result.
 * @example
 * ```ts
 * await run({ target: "host", fs, global, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
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

  const buildScript = extractScriptName(input.global.web.build);
  const devScript = extractScriptName(input.global.web.devCommand);
  const missing: string[] = [];
  if (!buildScript || !(buildScript in scripts)) {
    missing.push(`web.build ("${input.global.web.build}")`);
  }
  if (!devScript || !(devScript in scripts)) {
    missing.push(`web.devCommand ("${input.global.web.devCommand}")`);
  }

  if (missing.length > 0) {
    return {
      id: "web-script",
      target: "host",
      status: "fail",
      message: `[native] script(s) not found in ${packageJsonPath}: ${missing.join(", ")}. Presence is necessary but not sufficient — this does not run the script.`,
      fixIt: `add the missing script(s) to ${packageJsonPath}, or update config.web to match existing scripts`
    };
  }
  return {
    id: "web-script",
    target: "host",
    status: "pass",
    message: `[native] web.build/web.devCommand scripts resolved in ${packageJsonPath} (not executed).`
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
