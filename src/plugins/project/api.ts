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
import { debugKeystorePath } from "./mobile/signing";
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
 * generators (the shell crate among them) + write-if-changed writer + mobile
 * completeness/patch/icon/link/clean + the page agent scan.
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
   * @param opts.profile - The build profile; `"store"` when omitted.
   * @returns Which paths were written, left unchanged, or skipped.
   * @example
   * ```ts
   * await generateArtifacts({ target: "macos" });
   * ```
   */
  const generateArtifacts = async (opts: {
    target: GeneratorInput["target"];
    profile?: BuildProfile | undefined;
  }): Promise<GenerateResult> => {
    const profile = opts.profile ?? "store";
    const capabilities = resolveConfiguredCapabilities(ctx.global, opts.target, profile);
    const input: GeneratorInput = { global: ctx.global, target: opts.target, capabilities };
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
      profile,
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
   * Builds the Android profile one patch pass applies. The debug profile resolves the debug
   * keystore from `ctx.env` here (`HOME` ?? `USERPROFILE`), so the patch itself never reads
   * the environment.
   *
   * @param opts - See {@link Api.patchMobile}.
   * @returns The Android profile with its app name, keystore and log.
   * @example
   * ```ts
   * androidProfile({ target: "android" }); // { profile: "store", log }
   * ```
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
   * @example
   * ```ts
   * await runPatchMobile({ target: "ios" }); // { patched: [], unchanged: [] } before `tauri ios init`
   * ```
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
   * @example
   * ```ts
   * await runPatchMobileIcons({ target: "ios" }); // { patched: [], unchanged: [] }
   * ```
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
   * @example
   * ```ts
   * await runDetectPageAgent(); // { agent: false } for a clean page
   * ```
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
   * @example
   * ```ts
   * await runCheckShellLinked({ target: "android" }); // resolves: no shell composed
   * ```
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

  /**
   * Removes the previous build output of a mobile target, so the next compile writes into
   * an empty tree — iOS only (Gradle manages Android's own `build` tree). Guarded by the
   * same derived-path rule as {@link runClean}.
   *
   * @param opts - The clear options.
   * @param opts.target - The mobile platform whose previous build output to remove.
   * @returns The paths actually removed — empty when there was nothing to remove.
   * @example
   * ```ts
   * await runClearMobileBuildOutput({ target: "ios" });
   * ```
   */
  const runClearMobileBuildOutput = async (opts: { target: MobileTarget }) => {
    const result = await clearMobileBuildOutput(ctx.global.projectDir, opts.target);
    ctx.log.debug("project:clearMobileBuildOutput", {
      target: opts.target,
      removed: result.removed.length
    });
    return result;
  };

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
    getRequiredFiles
  };
}
