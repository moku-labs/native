import { describe, expect, it } from "vitest";

import type { Orientation } from "../../../../../config";
import { generateSidecar } from "../../../generators/sidecar";
import type { PlistEntry, ResolvedCapability } from "../../../types";
import { baseGlobalConfig, generatorInputFor, generatorInputWith } from "./fixtures";

/** The plist preamble every generated sidecar opens with. */
const PLIST_HEAD = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">'
];

/** A whole sidecar file around the given `<dict>` body lines. */
const plistWith = (...body: string[]) =>
  [...PLIST_HEAD, "<dict>", ...body, "</dict>", "</plist>", ""].join("\n");

/** A capability that carries sidecar entries — no registry row does today. */
const capabilityCarrying = (sidecarPlist: readonly PlistEntry[]): ResolvedCapability => ({
  name: "notification",
  npmPackage: "@tauri-apps/plugin-notification",
  crate: "tauri-plugin-notification",
  crateRange: "^2",
  npmRange: "^2",
  rustInit: "tauri_plugin_notification::init()",
  cargoFeatures: [],
  permissions: ["notification:default"],
  platforms: ["ios"],
  confidence: "high",
  conf: {},
  sidecarPlist,
  manifest: []
});

/** The ios sidecar for an orientation and an explicit capability set. */
const sidecarFor = (orientation: Orientation | undefined, capabilities: ResolvedCapability[]) =>
  generateSidecar({
    global: {
      ...baseGlobalConfig,
      app: { ...baseGlobalConfig.app, ...(orientation ? { orientation } : {}) }
    },
    target: "ios",
    capabilities
  });

describe("generateSidecar", () => {
  it("writes an empty dict on ios when nothing contributes a key — a stale lock is cleared", () => {
    expect(generateSidecar(generatorInputFor("ios"))).toEqual([
      { path: "src-tauri/Info.ios.plist", content: plistWith() }
    ]);
    expect(plistWith()).toContain("<dict>\n</dict>");
  });

  it.each([
    "macos",
    "windows",
    "linux",
    "android"
  ] as const)("writes nothing on %s, even with an orientation set", target => {
    const input = generatorInputWith(target, {
      app: { ...baseGlobalConfig.app, orientation: "portrait" }
    });

    expect(generateSidecar(input)).toEqual([]);
  });

  it("serialises the portrait lock as string arrays and a boolean", () => {
    const [artifact] = sidecarFor("portrait", []);

    expect(artifact?.content).toBe(
      plistWith(
        "  <key>UISupportedInterfaceOrientations</key>",
        "  <array>",
        "    <string>UIInterfaceOrientationPortrait</string>",
        "  </array>",
        "  <key>UISupportedInterfaceOrientations~ipad</key>",
        "  <array>",
        "    <string>UIInterfaceOrientationPortrait</string>",
        "    <string>UIInterfaceOrientationPortraitUpsideDown</string>",
        "  </array>",
        "  <key>UIRequiresFullScreen</key>",
        "  <true/>"
      )
    );
  });

  it("serialises a string and a false boolean", () => {
    const [artifact] = sidecarFor(undefined, [
      capabilityCarrying([
        { key: "NSFutureUsageDescription", value: "Explains a future permission." },
        { key: "UIFileSharingEnabled", value: false }
      ])
    ]);

    expect(artifact?.content).toBe(
      plistWith(
        "  <key>NSFutureUsageDescription</key>",
        "  <string>Explains a future permission.</string>",
        "  <key>UIFileSharingEnabled</key>",
        "  <false/>"
      )
    );
  });

  it("XML-escapes keys and every kind of value", () => {
    const [artifact] = sidecarFor(undefined, [
      capabilityCarrying([
        { key: "A&B", value: `Tom & "Jerry" <cat's>` },
        { key: "List", value: ["<a>", "b&c"] }
      ])
    ]);

    expect(artifact?.content).toContain("  <key>A&amp;B</key>");
    expect(artifact?.content).toContain(
      "  <string>Tom &amp; &quot;Jerry&quot; &lt;cat&apos;s&gt;</string>"
    );
    expect(artifact?.content).toContain(
      "    <string>&lt;a&gt;</string>\n    <string>b&amp;c</string>"
    );
  });

  it("merges capability entries first, then the orientation entries", () => {
    const [artifact] = sidecarFor("landscape", [
      capabilityCarrying([{ key: "NSFutureUsageDescription", value: "Explains it." }])
    ]);

    const keys = [...(artifact?.content ?? "").matchAll(/<key>([^<]+)<\/key>/g)].map(
      match => match[1]
    );
    expect(keys).toEqual([
      "NSFutureUsageDescription",
      "UISupportedInterfaceOrientations",
      "UISupportedInterfaceOrientations~ipad",
      "UIRequiresFullScreen"
    ]);
  });

  it("lets the later entry win a duplicate key — orientation over a capability", () => {
    const [artifact] = sidecarFor("portrait", [
      capabilityCarrying([{ key: "UIRequiresFullScreen", value: false }])
    ]);

    expect(artifact?.content.match(/<key>UIRequiresFullScreen<\/key>/g)).toHaveLength(1);
    expect(artifact?.content).toContain("  <key>UIRequiresFullScreen</key>\n  <true/>");
    expect(artifact?.content).not.toContain("<false/>");
  });
});
