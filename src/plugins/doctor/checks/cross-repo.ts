/**
 * @file doctor plugin checks — cross-repo warn-only pointers (worker CORS; deep-link
 * .well-known). Never a native build failure — these point across the seam to a sibling
 * repo's config (D-011: keeps the cross-repo trace alive without blocking a native build).
 */
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/**
 * Always-fires pointer: packaged-app API calls originate from the Tauri webview origins,
 * which the worker's CORS allowlist must include.
 *
 * @param _input - Unused — this pointer's message never depends on config.
 * @returns The check result — always "warn".
 * @example
 * ```ts
 * await runCors(input);
 * ```
 */
async function runCors(_input: CheckInput): Promise<CheckResult> {
  return {
    id: "cross-repo-cors",
    target: "host",
    status: "warn",
    message:
      '[native] packaged-app API calls originate from "tauri://localhost" / "http://tauri.localhost" — verify the worker\'s CORS allowlist includes both origins.',
    fixIt: 'add "tauri://localhost" and "http://tauri.localhost" to the worker CORS allowlist'
  };
}

/** Worker CORS allowlist pointer — always fires (host-scoped). */
export const crossRepoCorsCheck: Check = {
  id: "cross-repo-cors",
  /**
   * Whether this check applies — host-scoped, always fires.
   *
   * @param target - The candidate scope.
   * @returns Whether `cross-repo-cors` applies to `target`.
   * @example
   * ```ts
   * crossRepoCorsCheck.appliesTo("host", global); // true
   * ```
   */
  appliesTo: target => target === "host",
  run: runCors
};

/**
 * Fires only when `deep-link` is composed: universal/app links are deferred post-v1
 * (D-011), and moving to universal mode will additionally need worker/CDN `.well-known`
 * files.
 *
 * @param _input - Unused — this pointer's message never depends on config beyond appliesTo's own filter.
 * @returns The check result — always "warn".
 * @example
 * ```ts
 * await runDeepLinkWellKnown(input);
 * ```
 */
async function runDeepLinkWellKnown(_input: CheckInput): Promise<CheckResult> {
  return {
    id: "cross-repo-deep-link-well-known",
    target: "host",
    status: "warn",
    message:
      "[native] deep-link is composed in scheme mode (universal/app links deferred, D-011) — moving to universal mode will additionally need worker/CDN .well-known/apple-app-site-association and .well-known/assetlinks.json.",
    fixIt:
      'track universal/app-link .well-known files as a follow-up when deep-link mode moves beyond "scheme"'
  };
}

/** deep-link .well-known pointer — fires only when deep-link is composed (host-scoped). */
export const crossRepoDeepLinkCheck: Check = {
  id: "cross-repo-deep-link-well-known",
  /**
   * Whether this check applies — host-scoped, and only when deep-link is composed.
   *
   * @param target - The candidate scope.
   * @param global - Frozen global framework config.
   * @returns Whether `cross-repo-deep-link-well-known` applies to `target`/`global`.
   * @example
   * ```ts
   * crossRepoDeepLinkCheck.appliesTo("host", global); // true when deep-link is composed
   * ```
   */
  appliesTo: (target, global) =>
    target === "host" && global.system.some(entry => entry.name === "deep-link"),
  run: runDeepLinkWellKnown
};
