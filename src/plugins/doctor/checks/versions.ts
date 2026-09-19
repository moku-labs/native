/**
 * @file doctor plugin check — `@tauri-apps/*` JS package versions vs registry-pinned crate
 * ranges (major-version skew only). Warn-only: a version skew is often still buildable.
 */
import path from "node:path";
import process from "node:process";
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/** The shape doctor reads out of a consumer `package.json`. */
type PackageJsonShape = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * Parses the leading major version number out of a version/range string (`"^2.1.0"`,
 * `"2"`, `"~2.3"` all yield `2`).
 *
 * @param input - A version or semver-range string.
 * @returns The leading major version number, or `undefined` if none is found.
 * @example
 * ```ts
 * parseMajor("^2.1.0"); // 2
 * ```
 */
function parseMajor(input: string): number | undefined {
  const match = /(\d+)/.exec(input);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Compares each composed capability's declared `@tauri-apps/*` npm version against the
 * registry-pinned Rust crate range's major version — a mismatch is cross-language skew,
 * which is often still buildable, so this check only ever warns.
 *
 * @param input - The check input (host-scoped).
 * @returns The check result — "pass" or "warn", never "fail".
 * @example
 * ```ts
 * await run({ target: "host", fs, project, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const packageJsonPath = path.join(process.cwd(), "package.json");

  let raw: string;
  try {
    raw = await input.fs.readFile(packageJsonPath);
  } catch {
    return {
      id: "tauri-version-skew",
      target: "host",
      status: "warn",
      message: `[native] could not read ${packageJsonPath} to check @tauri-apps/* version skew.`
    };
  }

  let pkg: PackageJsonShape;
  try {
    pkg = JSON.parse(raw) as PackageJsonShape;
  } catch {
    return {
      id: "tauri-version-skew",
      target: "host",
      status: "warn",
      message: `[native] ${packageJsonPath} is not valid JSON — skipped @tauri-apps/* version skew check.`
    };
  }

  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const skewed: string[] = [];
  for (const row of input.project.registryRows()) {
    // A1: a row can be backed by a cargo feature instead of a plugin (tray) — nothing to skew.
    if (!row.npmPackage || !row.crate || !row.crateRange) continue;
    const declaredVersion = declared[row.npmPackage];
    if (!declaredVersion) continue;
    const declaredMajor = parseMajor(declaredVersion);
    const crateMajor = parseMajor(row.crateRange);
    if (declaredMajor !== undefined && crateMajor !== undefined && declaredMajor !== crateMajor) {
      skewed.push(`${row.npmPackage}@${declaredVersion} vs crate ${row.crate}${row.crateRange}`);
    }
  }

  if (skewed.length > 0) {
    return {
      id: "tauri-version-skew",
      target: "host",
      status: "warn",
      message: `[native] @tauri-apps/* version skew detected: ${skewed.join("; ")}.`,
      fixIt:
        "align the npm package major version with the pinned Rust crate range, or re-run `native doctor` after upgrading"
    };
  }
  return {
    id: "tauri-version-skew",
    target: "host",
    status: "pass",
    message: "[native] no @tauri-apps/* version skew detected."
  };
}

/** `@tauri-apps/*` npm-vs-crate version skew — warn only, never fail (host-scoped). */
export const versionsCheck: Check = {
  id: "tauri-version-skew",
  /**
   * Whether this check applies — host-scoped only (one repo-wide package.json).
   *
   * @param target - The candidate scope.
   * @returns Whether `tauri-version-skew` applies to `target`.
   * @example
   * ```ts
   * versionsCheck.appliesTo("host", global); // true
   * ```
   */
  appliesTo: target => target === "host",
  run
};
