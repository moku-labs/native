/**
 * @file project plugin — API factory + config validation + capability resolution orchestration.
 */
import path from "node:path";
import type { Config } from "../../config";
import { clean } from "./clean";
import { completeness, requiredFiles } from "./completeness";
import { generateCapabilities } from "./generators/capabilities";
import { generateCargo } from "./generators/cargo";
import { generateRust } from "./generators/rust";
import { generateSidecar } from "./generators/sidecar";
import { generateTauriConf } from "./generators/tauri-conf";
import type { GeneratorInput } from "./generators/types";
import { patchMobile } from "./patch";
import {
  assertKnownCapabilities,
  isKnownCapability,
  registryRows,
  resolve,
  unknownCapabilityError
} from "./registry";
import type { Api, GenerateResult, ProjectContext, ResolvedCapability } from "./types";
import { writeIfChanged } from "./writer";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/i;

/**
 * Validates the global config at composition time — throws `[native]`-formatted errors
 * for missing app identity, missing web wiring, unknown `config.system` names, or a
 * `deep-link` composition missing its required scheme.
 *
 * @param global - Frozen global framework config.
 * @throws {Error} When app identity, web wiring, system names, or deep-link config are invalid.
 * @example
 * ```ts
 * validateProjectConfig(ctx.global);
 * ```
 */
export function validateProjectConfig(global: Readonly<Config>): void {
  if (!global.app.name) {
    throw new Error(
      "[native] app.name is required.\n  Set config.app.name to your app's display name."
    );
  }
  if (!IDENTIFIER_PATTERN.test(global.app.identifier)) {
    throw new Error(
      `[native] app.identifier "${global.app.identifier}" is not a valid reverse-DNS identifier.\n  Use a reverse-DNS identifier such as "com.example.myapp".`
    );
  }
  if (!global.web.build) {
    throw new Error(
      "[native] web.build is required.\n  Set config.web.build to the command that builds your web assets."
    );
  }
  if (!global.web.devCommand) {
    throw new Error(
      "[native] web.devCommand is required.\n  Set config.web.devCommand to the command that starts your dev server."
    );
  }
  if (!global.web.devUrl) {
    throw new Error(
      "[native] web.devUrl is required.\n  Set config.web.devUrl to your dev server's URL."
    );
  }
  if (!global.web.dist) {
    throw new Error(
      "[native] web.dist is required.\n  Set config.web.dist to your web build's output directory."
    );
  }

  assertKnownCapabilities(global.system);

  const usesDeepLink = global.system.some(entry => entry.name === "deep-link");
  if (usesDeepLink && !global.capabilities["deep-link"]?.scheme) {
    throw new Error(
      '[native] deep-link is composed in config.system but capabilities["deep-link"].scheme is missing.\n  Set capabilities["deep-link"] = { mode: "scheme", scheme: "yourscheme" }.'
    );
  }
}

/**
 * Resolves every capability configured on `config.system` against the registry, scoped
 * to rows whose `platforms` include the target (D-012: the whole packaging composition
 * is data-driven from this one pass).
 *
 * @param global - Frozen global framework config.
 * @param target - The packaging target being generated for.
 * @returns The resolved capabilities applicable to this target.
 * @throws {Error} When `config.system` names a capability the registry doesn't know.
 * @example
 * ```ts
 * resolveConfiguredCapabilities(ctx.global, "ios");
 * ```
 */
function resolveConfiguredCapabilities(
  global: Readonly<Config>,
  target: GeneratorInput["target"]
): ResolvedCapability[] {
  const resolved: ResolvedCapability[] = [];
  for (const entry of global.system) {
    if (!isKnownCapability(entry.name)) throw unknownCapabilityError(entry.name);
    const capability = resolve(entry.name, global.capabilities[entry.name]);
    if (capability.platforms.includes(target)) {
      resolved.push(capability);
    }
  }
  return resolved;
}

/**
 * Creates the project plugin API surface — capability registry + `.moku/tauri`
 * generators + write-if-changed writer + mobile completeness/patch/clean.
 *
 * @param ctx - Plugin context (global config, log).
 * @returns The `project` plugin's public API.
 * @example
 * ```ts
 * const api = createProjectApi(ctx);
 * await api.generate({ target: "macos" });
 * ```
 */
export function createProjectApi(ctx: ProjectContext): Api {
  /**
   * Write/refresh every pure artifact for `opts.target` into `projectDir` via
   * write-if-changed.
   *
   * @param opts - The generate options.
   * @param opts.target - The packaging target to generate for.
   * @returns Which paths were written, left unchanged, or skipped.
   * @example
   * ```ts
   * await generateArtifacts({ target: "macos" });
   * ```
   */
  const generateArtifacts = async (opts: {
    target: GeneratorInput["target"];
  }): Promise<GenerateResult> => {
    const capabilities = resolveConfiguredCapabilities(ctx.global, opts.target);
    const input: GeneratorInput = { global: ctx.global, target: opts.target, capabilities };
    const artifacts = [
      ...generateTauriConf(input),
      ...generateCargo(input),
      ...generateRust(input),
      ...generateCapabilities(input),
      ...generateSidecar(input)
    ];

    const result: GenerateResult = { written: [], unchanged: [], skipped: [] };
    for (const artifact of artifacts) {
      const fullPath = path.join(ctx.global.projectDir, artifact.path);
      const action = await writeIfChanged(fullPath, artifact.content);
      result[action].push(fullPath);
      ctx.log.debug("project:generate:artifact", { path: fullPath, action });
    }
    ctx.log.info("project:generate", {
      target: opts.target,
      written: result.written.length,
      unchanged: result.unchanged.length
    });
    return result;
  };

  /**
   * Checks the mobile `gen/<platform>` required-file completeness gate for `opts.target`.
   *
   * @param opts - The completeness check options.
   * @param opts.target - The packaging target to check.
   * @returns The completeness verdict.
   * @example
   * ```ts
   * checkCompleteness({ target: "android" });
   * ```
   */
  const checkCompleteness = (opts: { target: GeneratorInput["target"] }) =>
    completeness(ctx.global.projectDir, opts.target);

  /**
   * Runs the idempotent mobile post-init patch pass (v1: Android signing state only).
   *
   * @param opts - The patch options.
   * @param opts.target - The mobile platform to patch.
   * @returns The paths patched vs. left unchanged.
   * @example
   * ```ts
   * await runPatchMobile({ target: "android" });
   * ```
   */
  const runPatchMobile = async (opts: { target: "ios" | "android" }) => {
    const result = await patchMobile(ctx.global.projectDir, opts.target, ctx.global.signing);
    ctx.log.info("project:patchMobile", { target: opts.target, patched: result.patched.length });
    return result;
  };

  /**
   * Deletes derived state for the given scope (whole projectDir, a mobile gen/ tree, or
   * a desktop bundle output).
   *
   * @param opts - The clean options.
   * @param opts.target - The optional packaging target to scope the clean to.
   * @returns The list of paths actually removed.
   * @example
   * ```ts
   * await runClean({ target: "android" });
   * ```
   */
  const runClean = async (opts: { target?: GeneratorInput["target"] } = {}) => {
    const result = await clean(ctx.global.projectDir, opts.target);
    ctx.log.info("project:clean", { target: opts.target, removed: result.removed.length });
    return result;
  };

  return {
    generate: generateArtifacts,
    completeness: checkCompleteness,
    patchMobile: runPatchMobile,
    clean: runClean,
    resolve,
    isKnownCapability,
    registryRows,
    requiredFiles
  };
}
