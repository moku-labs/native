/**
 * @file project plugin — API factory: capability resolution, generation, and the mobile
 * patch/completeness/clean delegations. Composition-time validation lives in `validate.ts`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config, MobileTarget, Target } from "../../config";
import { clean } from "./clean";
import { generateBuildScript } from "./generators/build-script";
import { generateCapabilities } from "./generators/capabilities";
import { generateCargo } from "./generators/cargo";
import { generateEntitlements } from "./generators/entitlements";
import { generateRust } from "./generators/rust";
import { generateSidecar } from "./generators/sidecar";
import { generateTauriConf } from "./generators/tauri-conf";
import type { GeneratorInput } from "./generators/types";
import { placeholderIconPng } from "./icon";
import type { BundleLayout } from "./layout";
import { bundleLayout } from "./layout";
import { completeness, requiredFiles } from "./mobile/completeness";
import { patchMobile } from "./mobile/patch";
import { comparableRealPath } from "./paths";
import { isKnownCapability, registryRows, resolve, unknownCapabilityError } from "./registry";
import type {
  Api,
  GenerateResult,
  PatchMobileOptions,
  ProjectContext,
  ResolvedCapability
} from "./types";
import { writeIfChanged } from "./writer";

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
 * Returns the required-file set a mobile `gen/<platform>` tree must carry — the options
 * object keeps every target-scoped API method reading the same way.
 *
 * @param opts - The lookup options.
 * @param opts.target - The mobile platform to list required files for.
 * @returns The required paths, relative to `src-tauri/gen/<platform>`.
 * @example
 * ```ts
 * getRequiredFiles({ target: "android" });
 * ```
 */
function getRequiredFiles(opts: { target: MobileTarget }): readonly string[] {
  return requiredFiles(opts.target);
}

/**
 * Returns where one target's build output lands inside the generated project — read from
 * `layout.ts`, the single owner of that table, so build's collect phase never keeps a copy.
 *
 * @param opts - The lookup options.
 * @param opts.target - The packaging target.
 * @returns The output root, bundle formats, and mobile `gen/` directory for that target.
 * @example
 * ```ts
 * getBundleLayout({ target: "macos" });
 * ```
 */
function getBundleLayout(opts: { target: Target }): BundleLayout {
  return bundleLayout(opts.target);
}

/**
 * Resolves a path to the one comparable form every containment guard in this framework
 * compares in: absolute, symlinks followed, and case-folded where the filesystem is. This
 * plugin owns that rule (the clean guard and the config check are built on it), and build's
 * collect guard borrows it through the API rather than keeping a second, lexical copy — a
 * lexical guard is walked around by a single symlink.
 *
 * For comparison only — the result is never a path to display or to hand to the filesystem.
 *
 * @param target - The path to resolve, absolute or relative to the process cwd.
 * @returns The comparable form of the real path.
 * @example
 * ```ts
 * resolveDerivedPath("dist-native/macos"); // "/repo/app/dist-native/macos"
 * ```
 */
function resolveDerivedPath(target: string): string {
  return comparableRealPath(target);
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
      ...generateBuildScript(),
      ...generateRust(input),
      ...generateCapabilities(input),
      ...generateEntitlements(input),
      ...generateSidecar(input)
    ];

    const buckets: Record<"written" | "unchanged" | "skipped", string[]> = {
      written: [],
      unchanged: [],
      skipped: []
    };
    for (const artifact of artifacts) {
      const fullPath = path.join(ctx.global.projectDir, artifact.path);
      const action = await writeIfChanged(fullPath, artifact.content, ctx.global.projectDir);
      buckets[action].push(fullPath);
      ctx.log.debug("project:generate:artifact", { path: fullPath, action });
    }
    ctx.log.info("project:generate", {
      target: opts.target,
      written: buckets.written.length,
      unchanged: buckets.unchanged.length
    });
    return buckets;
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
   * Runs the idempotent mobile post-init patch pass — Android release signing, plus the
   * Xcode/Android-Studio runner-command rewrite when a `runner` is supplied.
   *
   * @param opts - The patch options.
   * @param opts.target - The mobile platform to patch.
   * @param opts.runner - The absolute Node/`tauri.js` pair from `tauri.runner()`.
   * @returns The paths patched vs. left unchanged.
   * @example
   * ```ts
   * await runPatchMobile({ target: "ios", runner: tauri.runner() });
   * ```
   */
  const runPatchMobile = async (opts: PatchMobileOptions) => {
    const result = await patchMobile(ctx.global.projectDir, opts, ctx.global.signing);
    ctx.log.info("project:patchMobile", { target: opts.target, patched: result.patched.length });
    return result;
  };

  /**
   * Resolves the 1024x1024 source PNG `tauri icon` expands into the platform icon sets.
   * A configured `app.icon` is used verbatim; otherwise an embedded placeholder is written
   * into `projectDir`, so a brand-new app packages without drawing an icon first.
   *
   * @returns The absolute path to the icon source.
   * @throws {Error} When `app.icon` is set but no file exists there.
   * @example
   * ```ts
   * await tauri.icon({ source: await ensureIconSource() });
   * ```
   */
  const ensureIconSource = async (): Promise<string> => {
    const configured = ctx.global.app.icon;
    if (configured) {
      const resolved = path.resolve(configured);
      if (!existsSync(resolved)) {
        throw new Error(
          `[native] app.icon "${configured}" was not found at ${resolved}.\n  Point config.app.icon at a 1024x1024 PNG, or unset it to use the generated placeholder.`
        );
      }
      return resolved;
    }

    const placeholder = path.resolve(ctx.global.projectDir, "placeholder-icon.png");
    const action = await writeIfChanged(placeholder, placeholderIconPng(), ctx.global.projectDir);
    ctx.log.debug("project:ensureIconSource", { path: placeholder, action });
    return placeholder;
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
  const runClean = async (opts: { target?: Target | undefined } = {}) => {
    const result = await clean(ctx.global.projectDir, opts.target);
    ctx.log.info("project:clean", { target: opts.target, removed: result.removed.length });
    return result;
  };

  return {
    generate: generateArtifacts,
    getBundleLayout,
    getCompleteness: checkCompleteness,
    patchMobile: runPatchMobile,
    clean: runClean,
    resolveDerivedPath,
    ensureIconSource,
    resolve,
    isKnownCapability,
    getRegistryRows: registryRows,
    getRequiredFiles
  };
}
