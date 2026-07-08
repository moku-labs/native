/**
 * @file project plugin generator — Cargo.toml with registry-pinned crate dependencies.
 */
import type { Artifact, GeneratorInput } from "./types";

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
 * Generates `src-tauri/Cargo.toml` — the package manifest plus one pinned dependency
 * line per resolved capability that carries a real Rust plugin init (rows with an
 * empty `rustInit`, e.g. tray's core-feature row, contribute no crate dependency).
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
    .filter(capability => capability.rustInit !== "")
    .map(capability => `${capability.crate} = "${capability.crateRange}"`)
    .toSorted();

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
    'tauri = { version = "2", features = [] }',
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    ...pinnedDeps,
    ""
  ];

  return [{ path: "src-tauri/Cargo.toml", content: lines.join("\n") }];
}
