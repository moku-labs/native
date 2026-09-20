import { describe, expect, it } from "vitest";

import { entitlementsPath, generateEntitlements } from "../../../generators/entitlements";
import { generatorInputWith } from "./fixtures";

const appStoreSigning = { signing: { apple: { appStore: true } } };

describe("generateEntitlements", () => {
  it("writes the App Store sandbox plist for a macos target", () => {
    const artifacts = generateEntitlements(generatorInputWith("macos", appStoreSigning));

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe("src-tauri/Entitlements.plist");
    expect(artifacts[0]?.content).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>com.apple.security.app-sandbox</key>",
        "  <true/>",
        "  <key>com.apple.security.network.client</key>",
        "  <true/>",
        "</dict>",
        "</plist>",
        ""
      ].join("\n")
    );
  });

  it("writes nothing when appStore is not set", () => {
    expect(generateEntitlements(generatorInputWith("macos", { signing: {} }))).toEqual([]);
  });

  it("writes nothing on a non-macos target", () => {
    expect(generateEntitlements(generatorInputWith("ios", appStoreSigning))).toEqual([]);
  });

  it("writes nothing when the consumer supplied its own entitlements file", () => {
    const input = generatorInputWith("macos", {
      signing: { apple: { appStore: true, entitlements: "App.entitlements" } }
    });
    expect(generateEntitlements(input)).toEqual([]);
  });
});

describe("entitlementsPath", () => {
  it("points at the generated plist, relative to src-tauri", () => {
    expect(entitlementsPath(generatorInputWith("macos", appStoreSigning))).toBe(
      "Entitlements.plist"
    );
  });

  it("rebases a consumer entitlements path (cwd-relative) onto src-tauri, POSIX", () => {
    const input = generatorInputWith("macos", {
      signing: { apple: { entitlements: "apple/App.entitlements" } }
    });
    expect(entitlementsPath(input)).toBe("../../../apple/App.entitlements");
  });

  it("is undefined when neither a consumer file nor an App Store build is configured", () => {
    expect(entitlementsPath(generatorInputWith("macos", { signing: {} }))).toBeUndefined();
  });
});
