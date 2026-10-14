/**
 * @file project plugin — API factory: capability resolution, generation, and the mobile
 * patch/icon/link/completeness/clean delegations, plus the page agent scan. Composition-time
 * validation lives in `validate.ts`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { BuildProfile, Config, MobileTarget, Target } from "../../config";
import { clean, clearMobileBuildOutput } from "./clean";
import { generateBuildScript } from "./generators/build-script";
import { generateCapabilities } from "./generators/capabilities";
import { generateCargo } from "./generators/cargo";
import { generateEntitlements } from "./generators/entitlements";
import { generateRust } from "./generators/rust";
import { generateShell } from "./generators/shell";
import { generateSidecar } from "./generators/sidecar";
import { generateTauriConf } from "./generators/tauri-conf";
import type { GeneratorInput } from "./generators/types";
import { placeholderIconPng } from "./icon";
import type { BundleLayout } from "./layout";
import { bundleLayout, genDirectoryPath } from "./layout";
import { completeness, requiredFiles } from "./mobile/completeness";
import { patchAndroidIcon } from "./mobile/icon";
import { patchMobile } from "./mobile/patch";
import { checkShellLinked } from "./mobile/shell-link";
import { debugKeystorePath, resolveDebugKeystore } from "./mobile/signing";
import { orientationManifest } from "./orientation";
import { detectPageAgent } from "./page-agent";
import { comparableRealPath } from "./paths";
import {
  isKnownCapability,
  registryRows,
  resolve,
  resolveConfiguredCapabilities
} from "./registry";
import type {
  AndroidProfile,
  Api,
  DebugKeystore,
  GenerateResult,
  ManifestEntry,
  PatchMobileOptions,
  PatchResult,
  ProjectContext
} from "./types";
import { writeIfChanged } from "./writer";

/**
 * Collects what the Android manifest must carry: the attribute entries of every capability
 * resolved for android, then the orientation lock. Orientation comes last so it wins a
 * clash, the same order the iOS sidecar merges in. It is always present: an unset
 * orientation asks for `android:screenOrientation` to be absent, which removes a lock a
 * previous build left in the gen/ tree.
 *
 * @param global - Frozen global framework config.
 * @returns The manifest entries for `patchMobile`'s Android pass.
 * @example
 * ```ts
 * // `config` is any full native Config; no registry row carries a manifest entry today
 * androidManifestEntries({ ...config, app: { name: "Demo", identifier: "com.acme.demo", orientation: "portrait" } });
 * // [{ kind: "activity-attribute", name: "android:screenOrientation", value: "portrait" }]
 * ```
 */
function androidManifestEntries(global: Readonly<Config>): ManifestEntry[] {
  const fromCapabilities = resolveConfiguredCapabilities(global, "android")
    .flatMap(capability => capability.manifest)
    .filter(entry => entry.kind !== "child");
  return [...fromCapabilities, ...orientationManifest(global.app.orientation)];
}

/**
 * Implements {@link Api.getRequiredFiles}.
 *
 * @param opts - See {@link Api.getRequiredFiles}.
 * @param opts.target - The mobile platform to list required files for.
 * @returns See {@link Api.getRequiredFiles}.
 */
function getRequiredFiles(opts: { target: MobileTarget }): readonly string[] {
  return requiredFiles(opts.target);
}

/**
 * Implements {@link Api.getBundleLayout}.
 *
 * @param opts - See {@link Api.getBundleLayout}.
 * @param opts.target - The packaging target.
 * @returns See {@link Api.getBundleLayout}.
 */
function getBundleLayout(opts: { target: Target }): BundleLayout {
  return bundleLayout(opts.target);
}

/**
 * Implements {@link Api.resolveDerivedPath}.
 *
 * @param target - See {@link Api.resolveDerivedPath}.
 * @returns See {@link Api.resolveDerivedPath}.
 */
function resolveDerivedPath(target: string): string {
  return comparableRealPath(target);
}

/**
 * Creates the project plugin API surface — capability registry + `.moku/tauri`
 * generators (the shell crate among them) + write-if-changed writer + mobile
 * completeness/patch/icon/link/clean + the page agent scan.
 *
 * @param ctx - Plugin context (global config, log, env).
 * @returns The `project` plugin's public API.
 */
export function createProjectApi(ctx: ProjectContext): Api {
  /**
   * Implements {@link Api.generate}.
   *
   * @param opts - See {@link Api.generate}.
   * @param opts.target - The packaging target to generate for.
   * @param opts.profile - The build profile; `"store"` when omitted.
   * @returns See {@link Api.generate}.
   */
  const generateArtifacts = async (opts: {
    target: GeneratorInput["target"];
    profile?: BuildProfile | undefined;
  }): Promise<GenerateResult> => {
    // Resolve the capabilities this target and profile compose.
    const profile = opts.profile ?? "store";
    const capabilities = resolveConfiguredCapabilities(ctx.global, opts.target, profile);
    const input: GeneratorInput = { global: ctx.global, target: opts.target, capabilities };

    // Render every generated artifact, the shell crate last.
    const artifacts = [
      ...generateTauriConf(input),
      ...generateCargo(input),
      ...generateBuildScript(),
      ...generateRust(input),
      ...generateCapabilities(input),
      ...generateEntitlements(input),
      ...generateSidecar(input),
      ...generateShell(input, profile)
    ];

    // Write each one only when its content changed, and sort it into its bucket.
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

    // Report the pass, then hand the buckets back.
    ctx.log.info("project:generate", {
      target: opts.target,
      profile,
      written: buckets.written.length,
      unchanged: buckets.unchanged.length
    });
    return buckets;
  };

  /**
   * Implements {@link Api.getCompleteness}.
   *
   * @param opts - See {@link Api.getCompleteness}.
   * @param opts.target - The packaging target to check.
   * @returns See {@link Api.getCompleteness}.
   */
  const checkCompleteness = (opts: { target: GeneratorInput["target"] }) =>
    completeness(ctx.global.projectDir, opts.target);

  /**
   * Builds the Android profile one patch pass applies. The debug profile resolves the debug
   * keystore from `ctx.env` here (`HOME` ?? `USERPROFILE`), so the patch itself never reads
   * the environment.
   *
   * @param opts - See {@link Api.patchMobile}.
   * @returns The Android profile with its app name, keystore and log.
   */
  const androidProfile = (opts: PatchMobileOptions): AndroidProfile => {
    if (opts.target !== "android" || opts.profile !== "debug") {
      return { profile: "store", log: ctx.log };
    }
    return {
      profile: "debug",
      appName: ctx.global.app.name,
      debugKeystore: debugKeystorePath(ctx.env),
      log: ctx.log
    };
  };

  /**
   * Implements {@link Api.patchMobile}: hands Android its build profile, its manifest
   * entries and `app.backgroundColor` (the status bar icons follow it), then logs.
   *
   * @param opts - See {@link Api.patchMobile}.
   * @returns See {@link Api.patchMobile}.
   */
  const runPatchMobile = async (opts: PatchMobileOptions) => {
    const manifest = opts.target === "android" ? androidManifestEntries(ctx.global) : [];
    const profile = androidProfile(opts);
    const result = await patchMobile(
      ctx.global.projectDir,
      opts,
      ctx.global.signing,
      manifest,
      ctx.global.app.backgroundColor,
      profile
    );
    ctx.log.info("project:patchMobile", {
      target: opts.target,
      profile: profile.profile,
      patched: result.patched.length
    });
    return result;
  };

  /**
   * Implements {@link Api.patchMobileIcons}: the adaptive icon inset on Android, nothing on
   * iOS.
   *
   * @param opts - See {@link Api.patchMobileIcons}.
   * @param opts.target - The mobile platform whose icons to patch.
   * @returns See {@link Api.patchMobileIcons}.
   */
  const runPatchMobileIcons = async (opts: { target: MobileTarget }): Promise<PatchResult> => {
    if (opts.target !== "android") return { patched: [], unchanged: [] };
    const result = await patchAndroidIcon({
      projectDirectory: ctx.global.projectDir,
      genDirectory: genDirectoryPath(ctx.global.projectDir, opts.target),
      inset: ctx.global.app.adaptiveIconInset
    });
    ctx.log.debug("project:patchMobileIcons", {
      target: opts.target,
      patched: result.patched.length
    });
    return result;
  };

  /**
   * Implements {@link Api.detectPageAgent} over `<web.cwd ?? .>/<web.dist>`.
   *
   * @returns See {@link Api.detectPageAgent}.
   */
  const runDetectPageAgent = () =>
    detectPageAgent({ root: ctx.global.web.cwd ?? ".", dist: ctx.global.web.dist });

  /**
   * Implements {@link Api.checkShellLinked}, the store profile when omitted.
   *
   * @param opts - See {@link Api.checkShellLinked}.
   * @param opts.target - The mobile platform that was compiled.
   * @param opts.profile - The build profile; `"store"` when omitted.
   * @returns See {@link Api.checkShellLinked}.
   */
  const runCheckShellLinked = (opts: {
    target: MobileTarget;
    profile?: BuildProfile | undefined;
  }): Promise<void> =>
    checkShellLinked({
      global: ctx.global,
      target: opts.target,
      profile: opts.profile ?? "store"
    });

  /**
   * Implements {@link Api.ensureIconSource}.
   *
   * @returns See {@link Api.ensureIconSource}.
   * @throws {Error} See {@link Api.ensureIconSource}.
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
   * Implements {@link Api.clean}.
   *
   * @param opts - See {@link Api.clean}.
   * @param opts.target - The optional packaging target to scope the clean to.
   * @returns See {@link Api.clean}.
   */
  const runClean = async (opts: { target?: Target | undefined } = {}) => {
    const result = await clean(ctx.global.projectDir, opts.target);
    ctx.log.info("project:clean", { target: opts.target, removed: result.removed.length });
    return result;
  };

  /**
   * Implements {@link Api.clearMobileBuildOutput}.
   *
   * @param opts - See {@link Api.clearMobileBuildOutput}.
   * @param opts.target - The mobile platform whose previous build output to remove.
   * @returns See {@link Api.clearMobileBuildOutput}.
   */
  const runClearMobileBuildOutput = async (opts: { target: MobileTarget }) => {
    const result = await clearMobileBuildOutput(ctx.global.projectDir, opts.target);
    ctx.log.debug("project:clearMobileBuildOutput", {
      target: opts.target,
      removed: result.removed.length
    });
    return result;
  };

  /**
   * Implements {@link Api.getDebugKeystore} over `ctx.env`.
   *
   * @returns See {@link Api.getDebugKeystore}.
   */
  const getDebugKeystore = (): DebugKeystore => resolveDebugKeystore(ctx.env);

  return {
    generate: generateArtifacts,
    getBundleLayout,
    getCompleteness: checkCompleteness,
    patchMobile: runPatchMobile,
    patchMobileIcons: runPatchMobileIcons,
    detectPageAgent: runDetectPageAgent,
    checkShellLinked: runCheckShellLinked,
    clean: runClean,
    clearMobileBuildOutput: runClearMobileBuildOutput,
    resolveDerivedPath,
    ensureIconSource,
    resolve,
    isKnownCapability,
    getRegistryRows: registryRows,
    getRequiredFiles,
    getDebugKeystore
  };
}
