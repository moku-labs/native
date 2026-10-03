import { describe, expect, it } from "vitest";

import type { Target } from "../../../../../config";
import { generateCapabilities } from "../../../generators/capabilities";
import { resolve } from "../../../registry";
import { generatorInputComposing, generatorInputFor } from "./fixtures";

/** The haptics row's four commands — the plugin ships no default permission set. */
const HAPTICS_PERMISSIONS = [
  "haptics:allow-impact-feedback",
  "haptics:allow-notification-feedback",
  "haptics:allow-selection-feedback",
  "haptics:allow-vibrate"
];

/** The permission list for `back` + `haptics`, platform-filtered the way `api.ts` resolves them. */
const backAndHapticsPermissionsFor = (target: Target): string[] => {
  const capabilities = [resolve("back"), resolve("haptics")].filter(capability =>
    capability.platforms.includes(target)
  );
  const [artifact] = generateCapabilities(generatorInputComposing(target, capabilities));
  return JSON.parse(artifact?.content ?? "{}").permissions;
};

describe("generateCapabilities", () => {
  it("writes a single src-tauri/capabilities/default.json artifact", () => {
    const artifacts = generateCapabilities(generatorInputFor("macos"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe("src-tauri/capabilities/default.json");
  });

  it.each([
    ["macos", "macOS"],
    ["ios", "iOS"],
    ["windows", "windows"],
    ["linux", "linux"],
    ["android", "android"]
  ] as const)("maps %s to Tauri's %s platform id", (target, platformId) => {
    const [artifact] = generateCapabilities(generatorInputFor(target));
    const doc = JSON.parse(artifact?.content ?? "{}");
    expect(doc.platforms).toEqual([platformId]);
  });

  it("starts the permission list with core:default", () => {
    const [artifact] = generateCapabilities(generatorInputFor("ios"));
    const doc = JSON.parse(artifact?.content ?? "{}");
    expect(doc.permissions[0]).toBe("core:default");
  });

  it("aggregates permissions from every resolved capability, tray excluded on mobile", () => {
    const [artifact] = generateCapabilities(generatorInputFor("ios"));
    const doc = JSON.parse(artifact?.content ?? "{}");

    expect(doc.permissions).toContain("store:default");
    expect(doc.permissions).toContain("deep-link:default");
    expect(doc.permissions).not.toContain("core:tray:default");
  });

  it("includes tray's permission on a desktop target", () => {
    const [artifact] = generateCapabilities(generatorInputFor("macos"));
    const doc = JSON.parse(artifact?.content ?? "{}");
    expect(doc.permissions).toContain("core:tray:default");
  });

  it("writes the exact macOS permission list, tray's core grants included", () => {
    const [artifact] = generateCapabilities(generatorInputFor("macos"));
    const doc = JSON.parse(artifact?.content ?? "{}");

    expect(doc).toEqual({
      identifier: "default",
      description: "Auto-generated capability set for the composed system plugins.",
      windows: ["main"],
      platforms: ["macOS"],
      permissions: [
        "core:default",
        "store:default",
        "notification:default",
        "clipboard-manager:allow-read-text",
        "clipboard-manager:allow-write-text",
        "core:tray:default",
        "core:menu:default",
        "core:image:default",
        "core:resources:default",
        "core:app:allow-default-window-icon",
        "deep-link:default"
      ]
    });
  });

  it("writes the exact iOS permission list, with no tray grant at all", () => {
    const [artifact] = generateCapabilities(generatorInputFor("ios"));
    const doc = JSON.parse(artifact?.content ?? "{}");

    expect(doc).toEqual({
      identifier: "default",
      description: "Auto-generated capability set for the composed system plugins.",
      windows: ["main"],
      platforms: ["iOS"],
      permissions: [
        "core:default",
        "store:default",
        "notification:default",
        "clipboard-manager:allow-read-text",
        "clipboard-manager:allow-write-text",
        "deep-link:default"
      ]
    });
  });

  it("grants back's exit and haptics' four commands on android", () => {
    expect(backAndHapticsPermissionsFor("android")).toEqual([
      "core:default",
      "core:app:allow-exit",
      ...HAPTICS_PERMISSIONS
    ]);
  });

  it("grants haptics' four commands but no exit on ios — back is Android-only", () => {
    expect(backAndHapticsPermissionsFor("ios")).toEqual(["core:default", ...HAPTICS_PERMISSIONS]);
  });

  it.each([
    "macos",
    "windows",
    "linux"
  ] as const)("grants neither on %s — both rows are mobile-only", target => {
    expect(backAndHapticsPermissionsFor(target)).toEqual(["core:default"]);
  });
});
