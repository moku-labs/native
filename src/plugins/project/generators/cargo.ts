/**
 * @file project plugin generator — Cargo.toml with registry-pinned crate dependencies, the
 * path dependency of every generated local crate, and the size profile of a release build.
 */
import path from "node:path";
import type { ResolvedCapability } from "../types";
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
 * The release profile, for every target and both build profiles: the debug build is a
 * release build too, so what a phone measures is what the store ships. It trades compile
 * time for a smaller library, and `panic = "abort"` drops the unwinding tables.
 */
const RELEASE_PROFILE = [
  "[profile.release]",
  "codegen-units = 1",
  "lto = true",
  'opt-level = "s"',
  'panic = "abort"',
  "strip = true"
];

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
 * Renders the one dependency line a capability adds to `[dependencies]`: a pinned version
 * for a published crate, a path for a crate this plugin generates (relative to
 * `src-tauri`, POSIX), nothing for a feature-only or permission-only row.
 *
 * @param capability - A capability resolved for the target.
 * @returns The TOML line, or undefined when the row ships no crate.
 * @example
 * ```ts
 * dependencyLine(resolve("shell")); // 'tauri-plugin-moku-shell = { path = "../plugins/moku-shell" }'
 * dependencyLine(resolve("store")); // 'tauri-plugin-store = "^2"'
 * ```
 */
function dependencyLine(capability: ResolvedCapability): string | undefined {
  if (capability.localCrate) {
    const cratePath = path.posix.join("..", capability.localCrate.directory);
    return `${capability.localCrate.name} = { path = "${cratePath}" }`;
  }
  if (capability.crate && capability.crateRange) {
    return `${capability.crate} = "${capability.crateRange}"`;
  }
  return undefined;
}

/**
 * Generates `src-tauri/Cargo.toml` — the package manifest, the `tauri` dependency with
 * every cargo feature the composed capabilities ask for (tray's `tray-icon`; without it
 * the tray API is not compiled in at all), plus one dependency line per resolved
 * capability that ships a crate: pinned for a published one, by path for the generated
 * shell crate. Feature-only and permission-only rows contribute no dependency line. The
 * `[profile.release]` table follows, and the iOS-only `objc2` table closes the file on
 * every target.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns A single-artifact array for `src-tauri/Cargo.toml`.
 */
export function generateCargo(input: GeneratorInput): Artifact[] {
  const packageName = sanitizePackageName(input.global.app.name);
  const pinnedDeps = input.capabilities
    .map(capability => dependencyLine(capability))
    .filter(line => line !== undefined)
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
    ...RELEASE_PROFILE,
    "",
    ...IOS_ONLY_DEPENDENCIES,
    ""
  ];

  return [{ path: "src-tauri/Cargo.toml", content: lines.join("\n") }];
}
