import { describe, expect, it } from "vitest";

import {
  assertKnownCapabilities,
  isKnownCapability,
  registryRows,
  resolve,
  unknownCapabilityError
} from "../../registry";

// ---------------------------------------------------------------------------
// registryRows / isKnownCapability
// ---------------------------------------------------------------------------

describe("registryRows", () => {
  it("has exactly 5 rows, one per CapabilityConfigMap key", () => {
    const rows = registryRows();
    expect(rows).toHaveLength(5);
    expect(rows.map(row => row.name).toSorted()).toEqual(
      ["clipboard-manager", "deep-link", "notification", "store", "tray"].toSorted()
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
      if (row.name === "tray") continue;
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

  it("every other row ships on all 5 targets", () => {
    for (const row of registryRows()) {
      if (row.name === "tray") continue;
      expect(row.platforms).toHaveLength(5);
    }
  });
});

describe("isKnownCapability", () => {
  it("narrows known capability names", () => {
    expect(isKnownCapability("store")).toBe(true);
    expect(isKnownCapability("deep-link")).toBe(true);
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
    for (const name of ["store", "notification", "clipboard-manager", "tray", "deep-link"]) {
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
