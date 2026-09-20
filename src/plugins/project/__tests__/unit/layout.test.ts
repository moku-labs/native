import { describe, expect, it } from "vitest";

import { TARGETS } from "../../../../config";
import { bundleLayout, genDirectoryName } from "../../layout";

describe("genDirectoryName", () => {
  it("maps ios to Tauri's apple directory and android to itself", () => {
    expect(genDirectoryName("ios")).toBe("apple");
    expect(genDirectoryName("android")).toBe("android");
  });
});

describe("bundleLayout", () => {
  it("puts desktop output under Cargo's release profile, with format directories", () => {
    const layout = bundleLayout("macos");

    expect(layout.root).toBe("src-tauri/target/release");
    expect(layout.genDirectory).toBeUndefined();
    expect(layout.formats.map(format => format.directory)).toEqual(["dmg", "macos"]);
    expect(layout.formats.map(format => format.pattern)).toEqual(["*.dmg", "*.app"]);
  });

  it("puts mobile output under src-tauri/gen/<platform>, with no bundle formats", () => {
    expect(bundleLayout("ios")).toEqual({
      root: "src-tauri",
      formats: [],
      genDirectory: "gen/apple"
    });
    expect(bundleLayout("android").genDirectory).toBe("gen/android");
  });

  it("resolves a layout for every packaging target", () => {
    for (const target of TARGETS) {
      const layout = bundleLayout(target);
      expect(layout.root.startsWith("src-tauri")).toBe(true);
      expect(layout.formats.length > 0 || layout.genDirectory !== undefined).toBe(true);
    }
  });
});
