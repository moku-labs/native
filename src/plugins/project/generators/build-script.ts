/**
 * @file project plugin generator — src-tauri/build.rs (the tauri_build compile-time hook).
 */
import type { Artifact } from "./types";

/**
 * Generates `src-tauri/build.rs`. Without it Cargo never runs `tauri_build::build()`, so
 * the capability files are never compiled into the binary and `tauri build` fails before
 * it reaches the bundler — this one file is what makes the generated tree buildable.
 * It carries no consumer input, so it takes no generator input.
 *
 * @returns A single-artifact array for `src-tauri/build.rs`.
 * @example
 * ```ts
 * generateBuildScript(); // [{ path: "src-tauri/build.rs", content: "fn main() {…}" }]
 * ```
 */
export function generateBuildScript(): Artifact[] {
  return [{ path: "src-tauri/build.rs", content: "fn main() {\n  tauri_build::build()\n}\n" }];
}
