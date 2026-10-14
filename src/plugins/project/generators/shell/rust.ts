/**
 * @file project plugin generator — the shell crate's Rust side: `Cargo.toml`, `build.rs`,
 * `src/lib.rs` and `permissions/default.toml`.
 */
import type { Artifact } from "../types";

/**
 * Generates the shell crate's Rust and permission files.
 *
 * @example
 * ```ts
 * shellRustArtifacts(); // Cargo.toml, build.rs, src/lib.rs, permissions/default.toml
 * ```
 */
export function shellRustArtifacts(): Artifact[] {
  throw new Error("not implemented");
}
