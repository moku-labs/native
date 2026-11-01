/**
 * @file project plugin — the post-init mobile patch pass: it decides WHICH patches a
 * platform needs and in which order. The patches themselves live next door, in
 * `profile.ts` (the Android build-profile patches), `signing.ts` (the Android
 * release-signing block), `manifest.ts` (the Android main activity's attributes, such as
 * the orientation lock), `system-bars.ts` (the Android status bar icon style from
 * `app.backgroundColor`), `window-background.ts` (the Android window and icon-splash
 * background from the same colour), `runner.ts` (the Xcode / Android-Studio runner command),
 * `xcode-settings.ts` (the iOS entitlements-modification setting that makes a REBUILD work),
 * `ios-project.ts` (the iOS deployment target and privacy manifest) and `ios-plist.ts` (the
 * debug keys a debug build left in the iOS `Info.plist`).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { BuildProfile, SigningConfig, TauriRunner } from "../../../config";
import { DEFAULT_IOS_MINIMUM_SYSTEM_VERSION } from "../generators/tauri-conf";
import { genDirectoryPath } from "../layout";
import type { AndroidProfile, ManifestEntry, PatchMobileOptions, PatchResult } from "../types";
import { patchIosInfoPlist } from "./ios-plist";
import { patchDeploymentTarget, patchPrivacyManifest, readPrivacyManifest } from "./ios-project";
import { patchAndroidManifest } from "./manifest";
import { patchAndroidProfile } from "./profile";
import { patchRunner } from "./runner";
import { assertDebugKeystore, patchAndroidSigning } from "./signing";
import { patchAndroidSystemBars } from "./system-bars";
import { patchAndroidWindowBackground } from "./window-background";
import { patchXcodeSettings } from "./xcode-settings";

/** The profile of a pass whose caller names none: the store profile, warnings dropped. */
const STORE_PROFILE: AndroidProfile = { profile: "store" };

/**
 * Merges the results of several patches over an overlapping file set into one report. A
 * file both patches touched is PATCHED — it appears once, and never in both lists.
 *
 * @param results - One result per patch, in the order the patches ran.
 * @returns The merged report.
 * @example
 * ```ts
 * mergePatchResults({ patched: ["a"], unchanged: ["b"] }, { patched: ["b"], unchanged: [] }); // { patched: ["a", "b"], unchanged: [] }
 * ```
 */
function mergePatchResults(...results: readonly PatchResult[]): PatchResult {
  const patched = new Set(results.flatMap(result => [...result.patched]));
  const unchanged = new Set(
    results.flatMap(result => result.unchanged.filter(file => !patched.has(file)))
  );
  return { patched: [...patched], unchanged: [...unchanged] };
}

/**
 * The iOS half of {@link patchMobile}: the Xcode entitlements-modification setting, the
 * deployment target, the privacy manifest, outside the debug profile the removal of the debug
 * `Info.plist` keys, then the runner command when the caller supplies a runner. A tree that
 * was never initialised is left alone and reports nothing.
 *
 * @param options - What to patch.
 * @param options.projectDirectory - The Tauri project root.
 * @param options.genDirectory - The `src-tauri/gen/apple` directory.
 * @param options.runner - The absolute Node/tauri.js runner pair, or undefined to keep it.
 * @param options.minimumVersion - The iOS deployment target to write.
 * @param options.privacyManifest - `ios.privacyManifest`; unset removes one a previous pass
 *   added.
 * @param options.profile - The build profile of this pass.
 * @returns The paths patched vs. left unchanged, merged over every patch.
 * @throws {Error} When the privacy manifest source is missing (before anything is written),
 *   a project file lacks a line a patch needs, or a debug key in `Info.plist` has no value.
 */
async function patchIos(options: {
  projectDirectory: string;
  genDirectory: string;
  runner: TauriRunner | undefined;
  minimumVersion: string;
  privacyManifest: string | undefined;
  profile: BuildProfile;
}): Promise<PatchResult> {
  const { projectDirectory, genDirectory, runner } = options;

  // No gen/apple tree yet: nothing to patch.
  if (!existsSync(genDirectory)) return { patched: [], unchanged: [] };

  // Read the manifest before anything is written.
  const manifest = await readPrivacyManifest(options.privacyManifest);

  // The entitlements setting: without it the second build of the same tree fails.
  const settingsResult = await patchXcodeSettings(projectDirectory, genDirectory);
  const deploymentResult = await patchDeploymentTarget(
    projectDirectory,
    genDirectory,
    options.minimumVersion
  );
  const privacyResult = await patchPrivacyManifest(projectDirectory, genDirectory, manifest);
  const iosResults = [settingsResult, deploymentResult, privacyResult];

  // A debug build merged its keys into Info.plist for good: only that profile keeps them.
  if (options.profile !== "debug") {
    iosResults.push(await patchIosInfoPlist(projectDirectory, genDirectory));
  }
  if (!runner) return mergePatchResults(...iosResults);

  // The runner command last, only when the caller names one.
  const runnerResult = await patchRunner(projectDirectory, genDirectory, {
    target: "ios",
    runner
  });
  return mergePatchResults(...iosResults, runnerResult);
}

/**
 * The Android half of {@link patchMobile}: the build-profile patches, the release signing
 * block, the main activity's manifest attributes, the status bar style, the window
 * background, then the runner command when the caller supplies a runner.
 *
 * @param options - What to patch.
 * @param options.projectDirectory - The Tauri project root.
 * @param options.genDirectory - The `src-tauri/gen/android` directory.
 * @param options.runner - The absolute Node/tauri.js runner pair, or undefined to keep it.
 * @param options.signing - The full signing config (only `.android` is consulted).
 * @param options.manifest - Android manifest entries for the main activity.
 * @param options.backgroundColor - `app.backgroundColor`, which the status bar icons and the
 *   window background follow.
 * @param options.profile - The Android build profile.
 * @returns The paths patched vs. left unchanged, merged over every patch.
 * @throws {Error} When the `gen/android` tree (or its `app/build.gradle.kts`) is missing, the
 *   debug keystore is missing in the debug profile, or a patch meets a tree it cannot patch.
 */
async function patchAndroid(options: {
  projectDirectory: string;
  genDirectory: string;
  runner: TauriRunner | undefined;
  signing: SigningConfig;
  manifest: readonly ManifestEntry[];
  backgroundColor: string | undefined;
  profile: AndroidProfile;
}): Promise<PatchResult> {
  const { projectDirectory, genDirectory, runner, profile } = options;

  // Refuse a tree `tauri android init` never completed.
  const buildGradlePath = path.join(genDirectory, "app", "build.gradle.kts");
  if (!existsSync(genDirectory) || !existsSync(buildGradlePath)) {
    throw new Error(
      `[native] Android gen/ tree not found or incomplete at ${genDirectory}.\n  Run the mobile init pass (tauri android init) before patching signing state.`
    );
  }

  // Check the debug keystore before anything is written.
  const debugKeystore = profile.profile === "debug" ? profile.debugKeystore : undefined;
  if (debugKeystore !== undefined) assertDebugKeystore(debugKeystore);

  // Profile before signing, so the store profile cuts its Gradle block out byte for byte.
  const profileResult = await patchAndroidProfile({ projectDirectory, genDirectory, profile });
  const signingResult = await patchAndroidSigning(
    projectDirectory,
    genDirectory,
    options.signing.android ?? {},
    debugKeystore
  );
  const manifestResult = await patchAndroidManifest(
    projectDirectory,
    genDirectory,
    options.manifest
  );
  const systemBarsResult = await patchAndroidSystemBars(
    projectDirectory,
    genDirectory,
    options.backgroundColor
  );
  const windowResult = await patchAndroidWindowBackground(
    projectDirectory,
    genDirectory,
    options.backgroundColor
  );
  const androidResults = [
    profileResult,
    signingResult,
    manifestResult,
    systemBarsResult,
    windowResult
  ];
  if (!runner) return mergePatchResults(...androidResults);

  // The runner command last, only when the caller names one.
  const runnerResult = await patchRunner(projectDirectory, genDirectory, {
    target: "android",
    runner
  });
  return mergePatchResults(...androidResults, runnerResult);
}

/**
 * Deterministic, idempotent post-init patch pass over an existing complete gen/ tree.
 * Android gets, in this order, its build-profile patches, its release signing block, the
 * main activity's manifest attributes, the system bar style in MainActivity.kt, the window
 * and icon-splash background in the app theme, then the runner command. The profile
 * patches run before signing so that the store profile cuts its Gradle block out byte for
 * byte, wherever the signing block sits. iOS gets the Xcode
 * entitlements-modification setting (without it the SECOND build of the same tree fails),
 * the deployment target and the privacy manifest (a kept tree never runs xcodegen again, so
 * both land in `project.yml` AND `project.pbxproj`), outside the debug profile the removal of
 * the debug keys a debug build merged into `Info.plist`, then the runner command. The runner
 * rewrite runs only when the caller supplies a `runner`. iOS takes no manifest entries and no
 * background colour: its orientation lock and signing travel through the generated
 * `Info.ios.plist` sidecar and tauri.conf.json, and its status bar adapts to the page on its
 * own. Its profile is `opts.profile`, because `profile` below reads store for iOS.
 *
 * @param projectDirectory - The Tauri project root.
 * @param opts - The mobile platform, optionally the absolute Node/tauri.js runner pair, and
 *   the build profile, which iOS reads here; the store profile when omitted.
 * @param signing - The full signing config (`.android` on Android, the iOS minimum in
 *   `.apple` on iOS).
 * @param manifest - Android manifest entries for the main activity (ignored on iOS).
 * @param backgroundColor - `app.backgroundColor`; the Android status bar icons, window
 *   background and icon-splash background follow it (ignored on iOS).
 * @param profile - The Android build profile, `dev` included as store; the store profile
 *   when omitted (ignored on iOS).
 * @param privacyManifest - `ios.privacyManifest`, an absolute path; unset removes one a
 *   previous pass added (ignored on Android).
 * @returns The paths patched vs. left unchanged, one merged report over every patch.
 * @throws {Error} When the Android `gen/android` tree (or its `app/build.gradle.kts`) is
 *   missing, the debug keystore is missing in the debug profile (before anything is
 *   written), manifest entries meet a missing manifest or an unclear main activity, a
 *   background colour meets a tree without exactly one MainActivity.kt to style or without
 *   the app theme to set the window background in; or when the iOS privacy manifest source
 *   is missing (before anything is written), `project.yml` or `project.pbxproj` lacks a line
 *   a patch needs, or a debug key in `Info.plist` has no value.
 */
export async function patchMobile(
  projectDirectory: string,
  opts: PatchMobileOptions,
  signing: SigningConfig,
  manifest: readonly ManifestEntry[] = [],
  backgroundColor?: string,
  profile: AndroidProfile = STORE_PROFILE,
  privacyManifest?: string
): Promise<PatchResult> {
  const genDirectory = genDirectoryPath(projectDirectory, opts.target);

  // iOS: the Xcode project files, and the runner command.
  if (opts.target === "ios") {
    return patchIos({
      projectDirectory,
      genDirectory,
      runner: opts.runner,
      minimumVersion: signing.apple?.iosMinimumSystemVersion ?? DEFAULT_IOS_MINIMUM_SYSTEM_VERSION,
      privacyManifest,
      profile: opts.profile ?? "store"
    });
  }

  // Android: the full ordered pass.
  return patchAndroid({
    projectDirectory,
    genDirectory,
    runner: opts.runner,
    signing,
    manifest,
    backgroundColor,
    profile
  });
}
