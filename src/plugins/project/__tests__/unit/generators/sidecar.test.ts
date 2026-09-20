import { describe, expect, it } from "vitest";

import { generateSidecar } from "../../../generators/sidecar";
import type { ResolvedCapability } from "../../../types";
import { generatorInputFor } from "./fixtures";

describe("generateSidecar", () => {
  it("emits nothing for every real v1 registry row (all sidecarPlist empty)", () => {
    expect(generateSidecar(generatorInputFor("ios"))).toEqual([]);
    expect(generateSidecar(generatorInputFor("macos"))).toEqual([]);
    expect(generateSidecar(generatorInputFor("android"))).toEqual([]);
  });

  it("activates the seam for a synthetic future row carrying sidecarPlist entries", () => {
    const syntheticCapability: ResolvedCapability = {
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
      sidecarPlist: [{ key: "NSFutureUsageDescription", value: "Explains a future permission." }],
      manifest: []
    };

    const artifacts = generateSidecar({
      global: generatorInputFor("ios").global,
      target: "ios",
      capabilities: [syntheticCapability]
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe("src-tauri/Info.ios.plist");
    expect(artifacts[0]?.content).toContain("<key>NSFutureUsageDescription</key>");
    expect(artifacts[0]?.content).toContain("<string>Explains a future permission.</string>");
  });
});
