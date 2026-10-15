import { describe, expect, it } from "vitest";

import type { Config } from "../../../../config";
import {
  assertKnownCapabilities,
  isKnownCapability,
  registryRows,
  resolve,
  resolveConfiguredCapabilities,
  unknownCapabilityError
} from "../../registry";
import { baseGlobalConfig } from "./generators/fixtures";

// ---------------------------------------------------------------------------
// registryRows / isKnownCapability
// ---------------------------------------------------------------------------

describe("registryRows", () => {
  it("has exactly 8 rows, one per CapabilityConfigMap key", () => {
    const rows = registryRows();
    expect(rows).toHaveLength(8);
    expect(rows.map(row => row.name).toSorted()).toEqual(
      [
        "back",
        "clipboard-manager",
        "deep-link",
        "haptics",
        "notification",
        "shell",
        "store",
        "tray"
      ].toSorted()
    );
  });

  it("every row carries a confidence marker", () => {
    for (const row of registryRows()) {
      expect(["high", "medium", "low"]).toContain(row.confidence);
    }
  });

  it("tray is filtered from mobile target-sets (desktop-only)", () => {
    const tray = registryRows().find(row => row.name === "tray");
    expect(tray?.platforms).not.toContain("ios");
    expect(tray?.platforms).not.toContain("android");
    expect(tray?.platforms).toEqual(["macos", "windows", "linux"]);
  });

  it("tray carries a cargo feature instead of a crate, npm package or rust init", () => {
    const tray = registryRows().find(row => row.name === "tray");
    expect(tray?.cargoFeatures).toEqual(["tray-icon"]);
    expect(tray?.crate).toBeUndefined();
    expect(tray?.crateRange).toBeUndefined();
    expect(tray?.npmPackage).toBeUndefined();
    expect(tray?.npmRange).toBeUndefined();
    expect(tray?.rustInit).toBeUndefined();
  });

  it("every plugin-backed row carries no cargo feature", () => {
    for (const row of registryRows()) {
      // tray is a cargo feature, back core permissions, shell a generated local crate.
      if (row.name === "tray" || row.name === "back" || row.name === "shell") continue;
      expect(row.cargoFeatures).toEqual([]);
      expect(row.crate).toBeDefined();
      expect(row.npmPackage).toBeDefined();
    }
  });

  it("returns copies — mutating a returned row does not corrupt the registry", () => {
    const store = registryRows().find(row => row.name === "store");
    expect(store).toBeDefined();
    if (store) store.confidence = "low";

    expect(registryRows().find(row => row.name === "store")?.confidence).toBe("high");
  });

  it("every row but tray, back, haptics and shell ships on all 5 targets", () => {
    for (const row of registryRows()) {
      if (["tray", "back", "haptics", "shell"].includes(row.name)) continue;
      expect(row.platforms).toHaveLength(5);
    }
  });

  it("back is an Android-only permission row: exit, no crate, no package, no init", () => {
    expect(registryRows().find(row => row.name === "back")).toEqual({
      name: "back",
      cargoFeatures: [],
      permissions: ["core:app:allow-exit"],
      platforms: ["android"],
      confidence: "high"
    });
  });

  it("haptics is a mobile-only plugin row granting its four commands by name", () => {
    expect(registryRows().find(row => row.name === "haptics")).toEqual({
      name: "haptics",
      npmPackage: "@tauri-apps/plugin-haptics",
      crate: "tauri-plugin-haptics",
      crateRange: "^2",
      npmRange: "^2",
      rustInit: "tauri_plugin_haptics::init()",
      cargoFeatures: [],
      permissions: [
        "haptics:allow-impact-feedback",
        "haptics:allow-notification-feedback",
        "haptics:allow-selection-feedback",
        "haptics:allow-vibrate"
      ],
      platforms: ["ios", "android"],
      confidence: "high"
    });
  });
});

describe("isKnownCapability", () => {
  it("narrows known capability names", () => {
    expect(isKnownCapability("store")).toBe(true);
    expect(isKnownCapability("deep-link")).toBe(true);
    expect(isKnownCapability("back")).toBe(true);
    expect(isKnownCapability("haptics")).toBe(true);
  });

  it("rejects unknown names", () => {
    expect(isKnownCapability("bogus")).toBe(false);
  });
});

describe("assertKnownCapabilities", () => {
  it("does not throw when every entry is known", () => {
    expect(() => assertKnownCapabilities([{ name: "store" }, { name: "tray" }])).not.toThrow();
  });

  it("throws the unknown-capability error at the first unrecognized name", () => {
    expect(() => assertKnownCapabilities([{ name: "store" }, { name: "bogus" }])).toThrow(
      '[native] Unknown capability "bogus"'
    );
  });
});

describe("unknownCapabilityError", () => {
  it("lists every known capability name", () => {
    const error = unknownCapabilityError("bogus");
    expect(error.message).toContain('Unknown capability "bogus"');
    for (const name of [
      "store",
      "notification",
      "clipboard-manager",
      "tray",
      "deep-link",
      "back",
      "haptics",
      "shell"
    ]) {
      expect(error.message).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

describe("resolve", () => {
  it("resolves store with an empty conf fragment", () => {
    const resolved = resolve("store");
    expect(resolved.name).toBe("store");
    expect(resolved.conf).toEqual({});
    expect(resolved.sidecarPlist).toEqual([]);
    expect(resolved.manifest).toEqual([]);
  });

  it("resolves notification", () => {
    const resolved = resolve("notification");
    expect(resolved.crate).toBe("tauri-plugin-notification");
    expect(resolved.permissions).toContain("notification:default");
  });

  it("resolves clipboard-manager", () => {
    const resolved = resolve("clipboard-manager");
    expect(resolved.npmPackage).toBe("@tauri-apps/plugin-clipboard-manager");
  });

  it.each([
    "back",
    "haptics"
  ] as const)("resolves %s with no conf, plist or manifest need", name => {
    const resolved = resolve(name);
    expect(resolved.conf).toEqual({});
    expect(resolved.sidecarPlist).toEqual([]);
    expect(resolved.manifest).toEqual([]);
  });

  it("resolves tray", () => {
    const resolved = resolve("tray");
    expect(resolved.platforms).not.toContain("ios");
  });

  it("tray names every core permission its icon, menu and image calls need", () => {
    const tray = registryRows().find(row => row.name === "tray");
    expect(tray?.permissions).toEqual([
      "core:tray:default",
      "core:menu:default",
      "core:image:default",
      "core:resources:default",
      "core:app:allow-default-window-icon"
    ]);
  });

  it("tray grants the default-window-icon command core:default leaves out", () => {
    const resolved = resolve("tray");
    expect(resolved.permissions).toContain("core:app:allow-default-window-icon");
  });

  it("threads the deep-link scheme into both the desktop and the mobile conf shape", () => {
    const resolved = resolve("deep-link", { mode: "scheme", scheme: "myapp" });
    expect(resolved.conf).toEqual({
      desktop: { schemes: ["myapp"] },
      mobile: [{ scheme: ["myapp"], appLink: false }]
    });
  });

  it("throws when resolving deep-link without a scheme", () => {
    expect(() => resolve("deep-link")).toThrow(
      "[native] deep-link capability requires a non-empty scheme"
    );
  });

  // -------------------------------------------------------------------------
  // Type-level: resolve<K> generic narrowing
  // -------------------------------------------------------------------------

  it("type-level: rejects an unknown capability name at compile time", () => {
    expect(() => {
      // @ts-expect-error -- "nope" is not a key of CapabilityConfigMap
      resolve("nope");
    }).toThrow();
  });

  it("type-level: rejects a malformed deep-link config at compile time", () => {
    expect(() => {
      // @ts-expect-error -- mode must be the literal "scheme", and scheme is required
      resolve("deep-link", { mode: "bogus" });
    }).toThrow();
  });

  it("type-level: accepts a well-formed deep-link config at compile time", () => {
    expect(() => resolve("deep-link", { mode: "scheme", scheme: "x" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveConfiguredCapabilities — the one opt-in path, and debug implying shell
// ---------------------------------------------------------------------------

/** A config composing exactly `system`, with the given capability parameters. */
const composing = (
  system: Config["system"],
  capabilities: Config["capabilities"] = {}
): Config => ({ ...baseGlobalConfig, system, capabilities });

/** The names resolved for one target and profile. */
const names = (...args: Parameters<typeof resolveConfiguredCapabilities>) =>
  resolveConfiguredCapabilities(...args).map(capability => capability.name);

describe("resolveConfiguredCapabilities", () => {
  it("composes shell for android when config.system names it, never for ios or macos", () => {
    const global = composing([{ name: "shell" }]);

    expect(names(global, "android")).toEqual(["shell"]);
    expect(names(global, "ios")).toEqual([]);
    expect(names(global, "macos")).toEqual([]);
  });

  it("capabilities.shell without a system entry composes nothing (bug: two opt-in paths drifting apart)", () => {
    expect(names(composing([], { shell: {} }), "android")).toEqual([]);
  });

  it("the debug profile composes shell on android without a system entry (bug: a debug build with no console forwarding)", () => {
    expect(names(composing([{ name: "store" }]), "android", "debug")).toEqual(["store", "shell"]);
    // Named AND implied: still one row, or lib.rs registers the plugin twice.
    expect(names(composing([{ name: "shell" }]), "android", "debug")).toEqual(["shell"]);
  });

  it("the debug profile composes no shell for a desktop target", () => {
    expect(names(composing([{ name: "store" }]), "macos", "debug")).toEqual(["store"]);
  });
});
