import path from "node:path";
import { describe, expect, it } from "vitest";

import { generateTauriConf } from "../../../generators/tauri-conf";
import { resolve } from "../../../registry";
import { generatorInputComposing, generatorInputFor, generatorInputWith } from "./fixtures";

const confFor = (...args: Parameters<typeof generatorInputFor>) => {
  const [artifact] = generateTauriConf(generatorInputFor(...args));
  return JSON.parse(artifact?.content ?? "{}");
};

/** The generated tauri.conf.json text for an explicit capability composition. */
const contentComposing = (...args: Parameters<typeof generatorInputComposing>) =>
  generateTauriConf(generatorInputComposing(...args))[0]?.content ?? "";

const deepLinkConf = {
  desktop: { schemes: ["mycoolapp"] },
  mobile: [{ scheme: ["mycoolapp"], appLink: false }]
};

describe("generateTauriConf", () => {
  it("emits bundle.windows.certificateThumbprint only when it is configured", () => {
    const signed = JSON.parse(
      generateTauriConf(
        generatorInputWith("windows", { signing: { windows: { certificateThumbprint: "A1B2C3" } } })
      )[0]?.content ?? "{}"
    );
    const unsigned = confFor("windows");

    expect(signed.bundle.windows.certificateThumbprint).toBe("A1B2C3");
    expect(unsigned.bundle.windows).toBeUndefined();
  });

  it("writes a single src-tauri/tauri.conf.json artifact", () => {
    const artifacts = generateTauriConf(generatorInputFor("macos"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe("src-tauri/tauri.conf.json");
  });

  it("carries app identity", () => {
    const conf = confFor("macos");
    expect(conf.productName).toBe("My Cool App");
    expect(conf.identifier).toBe("com.example.mycoolapp");
  });

  it("wires beforeDevCommand/beforeBuildCommand in object form with an explicit web cwd", () => {
    const conf = confFor("macos");
    expect(conf.build).toEqual({
      beforeDevCommand: { script: "bun run dev", cwd: path.resolve(".") },
      beforeBuildCommand: { script: "bun run build", cwd: path.resolve(".") },
      devUrl: "http://localhost:5173",
      frontendDist: "../../../dist"
    });
  });

  it("resolves frontendDist from src-tauri, honouring web.cwd, in POSIX form", () => {
    const input = generatorInputWith("macos", {
      web: {
        build: "bun run build",
        devCommand: "bun run dev",
        devUrl: "http://localhost:5173",
        dist: "build",
        cwd: "apps/web"
      }
    });
    const [artifact] = generateTauriConf(input);
    const conf = JSON.parse(artifact?.content ?? "{}");

    expect(conf.build.frontendDist).toBe("../../../apps/web/build");
    expect(conf.build.beforeBuildCommand.cwd).toBe(path.resolve("apps/web"));
  });

  it("declares the five bundle icon paths tauri icon produces", () => {
    const conf = confFor("macos");
    expect(conf.bundle.icon).toEqual([
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]);
  });

  it("keeps iOS and android blocks present but empty when no store metadata is set", () => {
    const conf = confFor("macos");
    expect(conf.bundle.iOS).toEqual({});
    expect(conf.bundle.android).toEqual({});
    expect(conf.bundle.macOS).toBeUndefined();
    expect(conf.bundle.category).toBeUndefined();
  });

  it("emits store metadata keys only when configured", () => {
    const input = generatorInputWith("macos", {
      app: {
        name: "My Cool App",
        identifier: "com.example.mycoolapp",
        version: "1.2.3",
        category: "Productivity",
        buildNumber: "42"
      },
      signing: {
        apple: { macosMinimumSystemVersion: "12.0", iosMinimumSystemVersion: "15.0" }
      }
    });
    const [artifact] = generateTauriConf(input);
    const conf = JSON.parse(artifact?.content ?? "{}");

    expect(conf.bundle.category).toBe("Productivity");
    expect(conf.bundle.iOS).toEqual({ minimumSystemVersion: "15.0", bundleVersion: "42" });
    expect(conf.bundle.macOS).toEqual({ minimumSystemVersion: "12.0", bundleVersion: "42" });
  });

  it("threads Apple signing identifiers into the iOS and macOS bundle blocks", () => {
    const input = generatorInputWith("macos", {
      signing: {
        apple: {
          teamId: "ABCDE12345",
          signingIdentity: "Developer ID Application: Alex (ABCDE12345)",
          providerShortName: "AlexCo",
          entitlements: "apple/App.entitlements"
        }
      }
    });
    const [artifact] = generateTauriConf(input);
    const conf = JSON.parse(artifact?.content ?? "{}");

    expect(conf.bundle.iOS).toEqual({ developmentTeam: "ABCDE12345" });
    expect(conf.bundle.macOS).toEqual({
      signingIdentity: "Developer ID Application: Alex (ABCDE12345)",
      providerShortName: "AlexCo",
      entitlements: "../../../apple/App.entitlements"
    });
  });

  it("points macOS entitlements at the generated sandbox plist for an App Store build", () => {
    const input = generatorInputWith("macos", { signing: { apple: { appStore: true } } });
    const [artifact] = generateTauriConf(input);
    const conf = JSON.parse(artifact?.content ?? "{}");

    expect(conf.bundle.macOS).toEqual({ entitlements: "Entitlements.plist" });
  });

  it("carries a plugins block holding ONLY the capabilities that have config", () => {
    const conf = confFor("macos");
    // All five are composed; deep-link is the only one whose Tauri plugin takes config.
    expect(conf.plugins).toEqual({ "deep-link": deepLinkConf });
  });

  it("keeps an empty plugins object when nothing is composed", () => {
    const content = contentComposing("macos", []);
    expect(JSON.parse(content).plugins).toEqual({});
    expect(content).toContain('"plugins": {}');
  });

  it("writes NO key for a capability whose Tauri plugin deserializes unit", () => {
    // store, notification and clipboard-manager take no config at all: a `{}` map under
    // their key aborts startup with `invalid type: map, expected unit`.
    const content = contentComposing("macos", [
      resolve("store"),
      resolve("notification"),
      resolve("clipboard-manager"),
      resolve("tray")
    ]);

    expect(JSON.parse(content).plugins).toEqual({});
    expect(content).not.toContain("clipboard-manager");
    expect(content).not.toContain("notification");
  });

  it("writes the deep-link key in desktop+mobile form, and only that key", () => {
    const content = contentComposing("macos", [
      resolve("store"),
      resolve("deep-link", { mode: "scheme", scheme: "mycoolapp" })
    ]);

    expect(JSON.parse(content).plugins).toEqual({ "deep-link": deepLinkConf });
  });

  it("omits tray's plugins block on a mobile target (platform-filtered upstream)", () => {
    const conf = confFor("ios");
    expect(conf.plugins).toEqual({ "deep-link": deepLinkConf });
  });
});
