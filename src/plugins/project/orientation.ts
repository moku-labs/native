/**
 * @file project plugin — the build-time orientation lock. One config field, two platform
 * shapes: the iOS `Info.plist` keys the sidecar generator writes, and the Android main
 * activity attribute the mobile patch pass sets. Nothing locks the screen at runtime.
 */
import type { Orientation } from "../../config";
import type { ManifestEntry, PlistEntry } from "./types";

const PORTRAIT = "UIInterfaceOrientationPortrait";
const PORTRAIT_UPSIDE_DOWN = "UIInterfaceOrientationPortraitUpsideDown";
const LANDSCAPE_SIDES = [
  "UIInterfaceOrientationLandscapeLeft",
  "UIInterfaceOrientationLandscapeRight"
];

/**
 * The iOS orientation lists per lock: the iPhone key, then the `~ipad` override. An iPhone
 * held portrait never turns upside down; an iPad does, so its portrait list keeps both.
 */
const IOS_ORIENTATIONS: Readonly<
  Record<Exclude<Orientation, "any">, { iphone: readonly string[]; ipad: readonly string[] }>
> = {
  portrait: { iphone: [PORTRAIT], ipad: [PORTRAIT, PORTRAIT_UPSIDE_DOWN] },
  landscape: { iphone: LANDSCAPE_SIDES, ipad: LANDSCAPE_SIDES }
};

/**
 * The Android `screenOrientation` per lock, matching the iOS lists: `portrait` has no
 * upside-down side, `sensorLandscape` turns between both landscape sides. `any` maps to no
 * attribute at all, the template's default.
 */
const ANDROID_SCREEN_ORIENTATION: Readonly<Record<Orientation, string | undefined>> = {
  portrait: "portrait",
  landscape: "sensorLandscape",
  any: undefined
};

/**
 * Builds the `Info.ios.plist` entries that lock the iOS orientation. A locked app also
 * asks for `UIRequiresFullScreen`: App Store review refuses an iPad app that restricts its
 * orientations without it. `any` and unset add nothing, so the template's default list
 * (every orientation) stays.
 *
 * @param orientation - The configured `app.orientation`, or undefined when unset.
 * @returns The plist entries, empty when the orientation is not locked.
 * @example
 * ```ts
 * orientationPlist("portrait")[0];
 * // { key: "UISupportedInterfaceOrientations", value: ["UIInterfaceOrientationPortrait"] }
 * ```
 */
export function orientationPlist(orientation: Orientation | undefined): PlistEntry[] {
  if (orientation === undefined || orientation === "any") return [];

  const { iphone, ipad } = IOS_ORIENTATIONS[orientation];
  return [
    { key: "UISupportedInterfaceOrientations", value: iphone },
    { key: "UISupportedInterfaceOrientations~ipad", value: ipad },
    { key: "UIRequiresFullScreen", value: true }
  ];
}

/**
 * Builds the Android manifest entry for the orientation lock: `android:screenOrientation`
 * on the main activity. `any` and unset ask for the attribute to be ABSENT rather than
 * adding nothing, so a lock a previous build wrote into the gen/ tree is removed again.
 *
 * @param orientation - The configured `app.orientation`, or undefined when unset.
 * @returns Exactly one `activity-attribute` entry.
 * @example
 * ```ts
 * orientationManifest("landscape");
 * // [{ kind: "activity-attribute", name: "android:screenOrientation", value: "sensorLandscape" }]
 * ```
 */
export function orientationManifest(orientation: Orientation | undefined): ManifestEntry[] {
  return [
    {
      kind: "activity-attribute",
      name: "android:screenOrientation",
      value: ANDROID_SCREEN_ORIENTATION[orientation ?? "any"]
    }
  ];
}
