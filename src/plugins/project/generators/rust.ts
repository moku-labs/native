/**
 * @file project plugin generator — main.rs/lib.rs with mobile entry point, plugin init
 * lines and the iOS safe-area setup hook.
 */
import { crateIdent, sanitizePackageName } from "./cargo";
import type { Artifact, GeneratorInput } from "./types";

/**
 * `Manager` brings `get_webview_window` into scope. Only the iOS arm of the setup hook
 * calls it, so the import is iOS-only too: anywhere else it would be an unused import.
 */
const IOS_MANAGER_IMPORT = ['#[cfg(target_os = "ios")]', "use tauri::Manager;"];

/**
 * The safe-area setup hook, as verified on the iOS 26.3 simulator. UIKit shrinks a
 * WKWebView page by the safe area while its scroll view stays on `.automatic`; `.never`
 * gives the page the whole screen, and CSS `env(safe-area-inset-*)` still reports the
 * notch. The `cfg` makes it a no-op off iOS, so `lib.rs` does not differ per target. The
 * window is tauri's default `main` label: the generated `app.windows` entry carries none.
 */
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
];

/**
 * Generates `src-tauri/src/lib.rs` and `src-tauri/src/main.rs`. `lib.rs` carries the
 * `#[cfg_attr(mobile, tauri::mobile_entry_point)]`-annotated `run()` with one
 * `.plugin(...)` init line per resolved capability that has a real Rust init (rows
 * without one, e.g. tray's cargo-feature row, contribute no line), then the iOS
 * safe-area `.setup` hook; `main.rs` is a thin entry point that calls into the lib crate.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns Artifacts for `src-tauri/src/lib.rs` and `src-tauri/src/main.rs`.
 * @example
 * ```ts
 * generateRust({ global, target: "android", capabilities: [] });
 * ```
 */
export function generateRust(input: GeneratorInput): Artifact[] {
  const packageIdent = crateIdent(sanitizePackageName(input.global.app.name));
  const pluginLines = input.capabilities
    .filter(capability => Boolean(capability.rustInit))
    .map(capability => `    .plugin(${capability.rustInit})`)
    .toSorted();

  const library = [
    ...IOS_MANAGER_IMPORT,
    "",
    "#[cfg_attr(mobile, tauri::mobile_entry_point)]",
    "pub fn run() {",
    "  tauri::Builder::default()",
    ...pluginLines,
    ...SAFE_AREA_SETUP,
    "    .run(tauri::generate_context!())",
    '    .expect("error while running tauri application");',
    "}",
    ""
  ].join("\n");

  const main = [
    '#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]',
    "",
    "fn main() {",
    `  ${packageIdent}_lib::run();`,
    "}",
    ""
  ].join("\n");

  return [
    { path: "src-tauri/src/lib.rs", content: library },
    { path: "src-tauri/src/main.rs", content: main }
  ];
}
