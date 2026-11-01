/**
 * @file project plugin generator — Info.ios.plist sidecar (src-tauri root, outside gen/):
 * the capabilities' keys, the game's, the debug profile's and the orientation lock.
 */
import type { BuildProfile } from "../../../config";
import { orientationPlist } from "../orientation";
import type { PlistEntry, PlistValue } from "../types";
import { escapeXml } from "../xml";
import type { Artifact, GeneratorInput } from "./types";

/** One indentation step of the generated plist. */
const PLIST_INDENT = "  ";

/** The key of the sentence iOS shows when it asks to reach the local network. */
export const LOCAL_NETWORK_USAGE_KEY = "NSLocalNetworkUsageDescription";

/** The key of App Transport Security, which refuses `ws://` to the editor by default. */
export const APP_TRANSPORT_SECURITY_KEY = "NSAppTransportSecurity";

/** The sentence iOS shows when an iOS debug build first reaches for the editor. */
const LOCAL_NETWORK_USAGE = "This debug build talks to the editor on your local network.";

/**
 * Tells a plist `<array>` from a `<dict>`: `Array.isArray` alone does not narrow a readonly
 * array.
 *
 * @param value - An array or a dictionary value.
 * @returns True, narrowing `value`, when it is an array.
 * @example
 * ```ts
 * isPlistArray(["a"]); // true
 * ```
 */
function isPlistArray(value: PlistValue): value is readonly PlistValue[] {
  return Array.isArray(value);
}

/**
 * Renders one dictionary's entries as `<key>` lines, each followed by its value. Every key is
 * XML-escaped.
 *
 * @param entries - The key/value pairs, in order.
 * @param indent - The indentation of the `<key>` lines.
 * @returns The entries' lines.
 * @example
 * ```ts
 * renderPlistEntries([["A&B", true]], "  "); // ["  <key>A&amp;B</key>", "  <true/>"]
 * ```
 */
function renderPlistEntries(
  entries: Iterable<readonly [string, PlistValue]>,
  indent: string
): string[] {
  return [...entries].flatMap(([key, value]) => [
    `${indent}<key>${escapeXml(key)}</key>`,
    ...renderPlistValue(value, indent)
  ]);
}

/**
 * Renders one plist value as the lines that follow its `<key>`: a `<string>`, a
 * `<true/>`/`<false/>`, or an `<array>` or `<dict>` holding more of them, as deep as the
 * value goes. Every text is XML-escaped.
 *
 * @param value - The entry value.
 * @param indent - The indentation of the value's first line.
 * @returns The value's lines.
 * @example
 * ```ts
 * renderPlistValue(["UIInterfaceOrientationPortrait"], "  ");
 * // ["  <array>", "    <string>UIInterfaceOrientationPortrait</string>", "  </array>"]
 * ```
 */
function renderPlistValue(value: PlistValue, indent: string): string[] {
  if (typeof value === "boolean") return [`${indent}${value ? "<true/>" : "<false/>"}`];
  if (typeof value === "string") return [`${indent}<string>${escapeXml(value)}</string>`];

  const nested = `${indent}${PLIST_INDENT}`;
  if (isPlistArray(value)) {
    return [
      `${indent}<array>`,
      ...value.flatMap(item => renderPlistValue(item, nested)),
      `${indent}</array>`
    ];
  }
  return [
    `${indent}<dict>`,
    ...renderPlistEntries(Object.entries(value), nested),
    `${indent}</dict>`
  ];
}

/**
 * Lists what the debug profile needs to reach the editor from an iPhone: the local-network
 * sentence, and App Transport Security opened for the local network alone. Every other
 * profile adds nothing, and the iOS patch pass takes both keys out of a kept tree again
 * (`mobile/ios-plist.ts`).
 *
 * @param profile - The build profile being generated for.
 * @returns The two entries in the debug profile, otherwise none.
 * @example
 * ```ts
 * debugPlist("store"); // []
 * ```
 */
function debugPlist(profile: BuildProfile): PlistEntry[] {
  if (profile !== "debug") return [];
  return [
    { key: LOCAL_NETWORK_USAGE_KEY, value: LOCAL_NETWORK_USAGE },
    { key: APP_TRANSPORT_SECURITY_KEY, value: { NSAllowsLocalNetworking: true } }
  ];
}

/**
 * Generates the `Info.ios.plist` SIDECAR at the src-tauri root, which Tauri merges into the
 * app's Info.plist on every iOS build. Its entries are every resolved capability's
 * `sidecarPlist`, then `ios.infoPlist`, then the debug profile's two keys, then the orientation
 * lock (`app.orientation`); on a duplicate key the later entry wins, so the app's keys beat a
 * capability, the debug keys beat a game's own in that profile only, and orientation beats
 * them all.
 *
 * On iOS the file is ALWAYS written, as an empty `<dict>` when nothing contributes a key:
 * the writer never deletes a file, and a portrait lock left in a stale sidecar would keep
 * being merged after the app went back to `any`. Every other target gets no artifact.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns An artifact for `src-tauri/Info.ios.plist` on iOS, otherwise an empty array.
 * @example
 * ```ts
 * // `config` is any full native Config
 * const global = { ...config, app: { name: "Demo", identifier: "com.acme.demo", orientation: "portrait" } };
 * generateSidecar({ global, target: "ios", capabilities: [], profile: "store" })[0]?.path; // "src-tauri/Info.ios.plist"
 * // its <dict>: UISupportedInterfaceOrientations, UISupportedInterfaceOrientations~ipad, UIRequiresFullScreen
 * generateSidecar({ global, target: "macos", capabilities: [], profile: "store" }); // []
 * ```
 */
export function generateSidecar(input: GeneratorInput): Artifact[] {
  if (input.target !== "ios") return [];

  // A Map keeps each key at its first position while a later `set` replaces the value.
  const entries = new Map<string, PlistValue>();
  const contributed = [
    ...input.capabilities.flatMap(capability => capability.sidecarPlist),
    ...Object.entries(input.global.ios?.infoPlist ?? {}).map(([key, value]) => ({ key, value })),
    ...debugPlist(input.profile),
    ...orientationPlist(input.global.app.orientation)
  ];
  for (const entry of contributed) entries.set(entry.key, entry.value);

  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...renderPlistEntries(entries, PLIST_INDENT),
    "</dict>",
    "</plist>",
    ""
  ].join("\n");

  return [{ path: "src-tauri/Info.ios.plist", content }];
}
