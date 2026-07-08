/**
 * @file project plugin generator — main.rs/lib.rs with mobile entry point + plugin init lines.
 */
import { crateIdent, sanitizePackageName } from "./cargo";
import type { Artifact, GeneratorInput } from "./types";

/**
 * Generates `src-tauri/src/lib.rs` and `src-tauri/src/main.rs`. `lib.rs` carries the
 * `#[cfg_attr(mobile, tauri::mobile_entry_point)]`-annotated `run()` with one
 * `.plugin(...)` init line per resolved capability that has a real Rust init (empty
 * `rustInit` rows, e.g. tray, contribute no line); `main.rs` is a thin entry point that
 * calls into the lib crate.
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
    .filter(capability => capability.rustInit !== "")
    .map(capability => `    .plugin(${capability.rustInit})`)
    .toSorted();

  const library = [
    "#[cfg_attr(mobile, tauri::mobile_entry_point)]",
    "pub fn run() {",
    "  tauri::Builder::default()",
    ...pluginLines,
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
