import { describe, expect, it } from "vitest";

import { generateRust } from "../../../generators/rust";
import { generatorInputFor } from "./fixtures";

describe("generateRust", () => {
  it("writes lib.rs and main.rs artifacts", () => {
    const artifacts = generateRust(generatorInputFor("macos"));
    expect(artifacts.map(artifact => artifact.path).toSorted()).toEqual(
      ["src-tauri/src/lib.rs", "src-tauri/src/main.rs"].toSorted()
    );
  });

  it("lib.rs carries the mobile_entry_point cfg_attr split", () => {
    const [lib] = generateRust(generatorInputFor("android"));
    expect(lib?.content).toContain("#[cfg_attr(mobile, tauri::mobile_entry_point)]");
    expect(lib?.content).toContain("pub fn run()");
  });

  it("lib.rs carries one .plugin(...) init line per capability with a real rustInit", () => {
    const [lib] = generateRust(generatorInputFor("macos"));
    expect(lib?.content).toContain(".plugin(tauri_plugin_store::Builder::default().build())");
    expect(lib?.content).toContain(".plugin(tauri_plugin_deep_link::init())");
  });

  it("lib.rs has no .plugin() line for tray (empty rustInit)", () => {
    const [lib] = generateRust(generatorInputFor("macos"));
    expect(lib?.content).not.toContain("tray");
  });

  it("main.rs calls into the underscored lib crate identifier", () => {
    const [, main] = generateRust(generatorInputFor("macos"));
    expect(main?.content).toContain("my_cool_app_lib::run();");
  });
});
