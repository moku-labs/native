/**
 * @file project plugin — the post-init mobile patch pass: it decides WHICH patches a
 * platform needs and in which order. The two patches themselves live next door, in
 * `signing.ts` (the Android release-signing block) and `runner.ts` (the Xcode /
 * Android-Studio runner command).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { SigningConfig } from "../../../config";
import { genDirectoryPath } from "../layout";
import type { PatchMobileOptions, PatchResult } from "../types";
import { patchRunner } from "./runner";
import { patchAndroidSigning } from "./signing";

/**
 * Deterministic, idempotent post-init patch pass over an existing complete gen/ tree.
 * Android gets its release signing block; both platforms get the runner-command rewrite
 * when the caller supplies a `runner` (omit it and the rewrite is skipped). iOS carries no
 * mobile-permission plist mechanism in v1 (D-012), so signing is conf-only there.
 *
 * @param projectDirectory - The Tauri project root.
 * @param opts - The mobile platform, and optionally the absolute Node/tauri.js runner pair.
 * @param signing - The full signing config (only `.android` is consulted).
 * @returns The paths patched vs. left unchanged.
 * @throws {Error} When the Android `gen/android` tree (or its `app/build.gradle.kts`) is missing.
 * @example
 * ```ts
 * await patchMobile("/repo/.moku/tauri", { target: "ios", runner }, {});
 * ```
 */
export async function patchMobile(
  projectDirectory: string,
  opts: PatchMobileOptions,
  signing: SigningConfig
): Promise<PatchResult> {
  const genDirectory = genDirectoryPath(projectDirectory, opts.target);

  if (opts.target === "ios") {
    if (!opts.runner || !existsSync(genDirectory)) return { patched: [], unchanged: [] };
    return patchRunner(projectDirectory, genDirectory, {
      target: opts.target,
      runner: opts.runner
    });
  }

  const buildGradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  if (!existsSync(genDirectory) || !existsSync(buildGradlePath)) {
    throw new Error(
      `[native] Android gen/ tree not found or incomplete at ${genDirectory}.\n  Run the mobile init pass (tauri android init) before patching signing state.`
    );
  }

  const result = await patchAndroidSigning(projectDirectory, genDirectory, signing.android ?? {});
  if (!opts.runner) return result;

  const runnerResult = await patchRunner(projectDirectory, genDirectory, {
    target: opts.target,
    runner: opts.runner
  });
  return {
    patched: [...result.patched, ...runnerResult.patched],
    unchanged: [...result.unchanged, ...runnerResult.unchanged]
  };
}
