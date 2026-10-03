/**
 * @file project plugin generator — Cargo.toml with registry-pinned crate dependencies.
 */
import type { Artifact, GeneratorInput } from "./types";

/**
 * The `tauri` crate floor. The `back` capability calls `exit()` and grants
 * `core:app:allow-exit`, and both exist only since tauri 2.12.0. `tauri-build` versions
 * on its own 2.x line, so its floor stays `"2"`.
 */
const TAURI_VERSION_FLOOR = "2.12";

/**
 * The dependencies only an iOS build compiles: the safe-area hook in the generated
 * `lib.rs` reaches WKWebView through `objc2`. A target table, written for every target,
 * so no other target ever builds the crate and the table adds no per-target difference.
 */
const IOS_ONLY_DEPENDENCIES = [`[target.'cfg(target_os = "ios")'.dependencies]`, 'objc2 = "0.6"'];

/**
 * Derives a valid Cargo package name from the app's display name — lowercased,
 * non-alphanumeric runs collapsed to a single hyphen, and guaranteed to start with a
 * letter (Cargo package names must match `[a-z][a-z0-9_-]*`).
 *
 * @param appName - The consumer app's display name (`Config["app"]["name"]`).
 * @returns A Cargo-safe package name; falls back to `"moku-native-app"` when empty.
 * @example
 * ```ts
 * sanitizePackageName("My Cool App!"); // "my-cool-app"
 * ```
 */
export function sanitizePackageName(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .join("-");

  if (slug.length === 0) return "moku-native-app";
  return /^[a-z]/.test(slug) ? slug : `app-${slug}`;
}

/**
 * Converts a Cargo package name (may contain hyphens) into the underscored Rust crate
 * identifier used in `[lib] name` and in `use`/path expressions — Cargo package names
 * may hyphenate, but Rust identifiers may not.
 *
 * @param packageName - A Cargo-safe package name, e.g. from `sanitizePackageName`.
 * @returns The underscored Rust identifier form.
 * @example
 * ```ts
 * crateIdent("my-cool-app"); // "my_cool_app"
 * ```
 */
export function crateIdent(packageName: string): string {
  return packageName.replaceAll("-", "_");
}

/**
 * Generates `src-tauri/Cargo.toml` — the package manifest, the `tauri` dependency with
 * every cargo feature the composed capabilities ask for (tray's `tray-icon`; without it
 * the tray API is not compiled in at all), plus one pinned dependency line per resolved
 * capability that ships a real crate. Feature-only and permission-only rows contribute
 * no dependency line. The iOS-only `objc2` table closes the file on every target.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns A single-artifact array for `src-tauri/Cargo.toml`.
 * @example
 * ```ts
 * generateCargo({ global, target: "macos", capabilities: [] });
 * ```
 */
export function generateCargo(input: GeneratorInput): Artifact[] {
  const packageName = sanitizePackageName(input.global.app.name);
  const pinnedDeps = input.capabilities
    .filter(capability => capability.crate && capability.crateRange)
    .map(capability => `${capability.crate} = "${capability.crateRange}"`)
    .toSorted();

  const features = [...new Set(input.capabilities.flatMap(capability => capability.cargoFeatures))]
    .toSorted()
    .map(feature => `"${feature}"`)
    .join(", ");

  const lines = [
    "[package]",
    `name = "${packageName}"`,
    `version = "${input.global.app.version ?? "0.1.0"}"`,
    'edition = "2021"',
    "",
    "[lib]",
    `name = "${crateIdent(packageName)}_lib"`,
    'crate-type = ["staticlib", "cdylib", "rlib"]',
    "",
    "[build-dependencies]",
    'tauri-build = { version = "2", features = [] }',
    "",
    "[dependencies]",
    `tauri = { version = "${TAURI_VERSION_FLOOR}", features = [${features}] }`,
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    ...pinnedDeps,
    "",
    ...IOS_ONLY_DEPENDENCIES,
    ""
  ];

  return [{ path: "src-tauri/Cargo.toml", content: lines.join("\n") }];
}
