/**
 * @file project plugin generator — Info.ios.plist sidecar (src-tauri root, outside gen/).
 */
import { orientationPlist } from "../orientation";
import type { PlistValue } from "../types";
import { escapeXml } from "../xml";
import type { Artifact, GeneratorInput } from "./types";

/**
 * Renders one plist value as the lines that follow its `<key>`: a `<string>`, a
 * `<true/>`/`<false/>`, or an `<array>` of strings. Every text is XML-escaped.
 *
 * @param value - The entry value.
 * @returns The value's lines, indented for the top-level `<dict>`.
 * @example
 * ```ts
 * renderPlistValue(["UIInterfaceOrientationPortrait"]);
 * // ["  <array>", "    <string>UIInterfaceOrientationPortrait</string>", "  </array>"]
 * ```
 */
function renderPlistValue(value: PlistValue): string[] {
  if (typeof value === "boolean") return [value ? "  <true/>" : "  <false/>"];
  if (typeof value === "string") return [`  <string>${escapeXml(value)}</string>`];
  return [
    "  <array>",
    ...value.map(item => `    <string>${escapeXml(item)}</string>`),
    "  </array>"
  ];
}

/**
 * Generates the `Info.ios.plist` SIDECAR at the src-tauri root, which Tauri merges into the
 * app's Info.plist on every iOS build. Its entries are every resolved capability's
 * `sidecarPlist`, then the orientation lock (`app.orientation`); on a duplicate key the
 * later entry wins, so orientation beats a capability.
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
 * generateSidecar({ global, target: "ios", capabilities: [] })[0]?.path; // "src-tauri/Info.ios.plist"
 * // its <dict>: UISupportedInterfaceOrientations, UISupportedInterfaceOrientations~ipad, UIRequiresFullScreen
 * generateSidecar({ global, target: "macos", capabilities: [] }); // []
 * ```
 */
export function generateSidecar(input: GeneratorInput): Artifact[] {
  if (input.target !== "ios") return [];

  // A Map keeps each key at its first position while a later `set` replaces the value.
  const entries = new Map<string, PlistValue>();
  const contributed = [
    ...input.capabilities.flatMap(capability => capability.sidecarPlist),
    ...orientationPlist(input.global.app.orientation)
  ];
  for (const entry of contributed) entries.set(entry.key, entry.value);

  const body = [...entries].flatMap(([key, value]) => [
    `  <key>${escapeXml(key)}</key>`,
    ...renderPlistValue(value)
  ]);

  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...body,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");

  return [{ path: "src-tauri/Info.ios.plist", content }];
}
