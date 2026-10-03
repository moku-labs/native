import { describe, expect, it } from "vitest";

import { generateRust } from "../../../generators/rust";
import { resolve } from "../../../registry";
import { generatorInputComposing, generatorInputFor } from "./fixtures";

/** The import the iOS arm of the setup hook needs — cfg-gated, so no other target warns. */
const IOS_MANAGER_IMPORT = ['#[cfg(target_os = "ios")]', "use tauri::Manager;"].join("\n");

/** The safe-area setup hook, line for line as it was verified on the iOS simulator. */
const SAFE_AREA_SETUP = [
  "    .setup(|_app| {",
  "      // wry leaves WKWebView's scroll view on .automatic, which shrinks the page by the",
  "      // safe area (tauri-apps/tauri#8166). .never gives the page the full screen.",
  '      #[cfg(target_os = "ios")]',
  '      if let Some(window) = _app.get_webview_window("main") {',
  "        window.with_webview(|webview| unsafe {",
  "          use objc2::{msg_send, runtime::AnyObject};",
  "          let wk = &*(webview.inner() as *mut AnyObject);",
  "          let scroll: *mut AnyObject = msg_send![wk, scrollView];",
  "          // UIScrollViewContentInsetAdjustmentNever = 2",
  "          let _: () = msg_send![&*scroll, setContentInsetAdjustmentBehavior: 2isize];",
  "        })?;",
  "      }",
  "      Ok(())",
  "    })"
].join("\n");

/** The generated lib.rs for an explicit capability composition. */
const libFor = (...args: Parameters<typeof generatorInputComposing>) =>
  generateRust(generatorInputComposing(...args))[0]?.content ?? "";

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

  it("lib.rs opens with the iOS-only Manager import, ahead of the entry point", () => {
    expect(libFor("ios", []).split("\n").slice(0, 4)).toEqual([
      '#[cfg(target_os = "ios")]',
      "use tauri::Manager;",
      "",
      "#[cfg_attr(mobile, tauri::mobile_entry_point)]"
    ]);
  });

  it("lib.rs is the builder, its sorted plugins, the safe-area hook and run — in that order", () => {
    expect(libFor("ios", [resolve("store"), resolve("haptics")])).toBe(
      [
        IOS_MANAGER_IMPORT,
        "",
        "#[cfg_attr(mobile, tauri::mobile_entry_point)]",
        "pub fn run() {",
        "  tauri::Builder::default()",
        "    .plugin(tauri_plugin_haptics::init())",
        "    .plugin(tauri_plugin_store::Builder::default().build())",
        SAFE_AREA_SETUP,
        "    .run(tauri::generate_context!())",
        '    .expect("error while running tauri application");',
        "}",
        ""
      ].join("\n")
    );
  });

  it("lib.rs carries the safe-area hook even when no capability is composed", () => {
    expect(libFor("ios", [])).toContain(
      `  tauri::Builder::default()\n${SAFE_AREA_SETUP}\n    .run(tauri::generate_context!())`
    );
  });

  it.each([
    "macos",
    "windows",
    "linux",
    "android"
  ] as const)("lib.rs on %s is the same file as on ios — the cfg makes the hook a no-op", target => {
    expect(libFor(target, [resolve("store")])).toBe(libFor("ios", [resolve("store")]));
  });

  it("lib.rs never names a window label of its own — the hook reads tauri's default `main`", () => {
    expect(libFor("ios", []).match(/get_webview_window\("([^"]+)"\)/)?.[1]).toBe("main");
  });

  it("lib.rs carries the haptics init line", () => {
    expect(libFor("android", [resolve("haptics")])).toContain(
      "    .plugin(tauri_plugin_haptics::init())\n"
    );
  });

  it("lib.rs carries no init line for back (core permissions only)", () => {
    expect(libFor("android", [resolve("back")])).not.toContain(".plugin(");
  });
});
