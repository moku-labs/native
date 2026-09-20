// biome-ignore-all assist/source/organizeImports: two-section barrel layout (instances → type namespaces) is house style
/**
 * Plugin barrel — re-exports all framework plugin instances, the one plugin-owned runtime
 * helper, and the per-plugin type namespaces.
 */

// ─── Plugin Instances ────────────────────────────────────────
export { buildPlugin } from "./build";
export { cliPlugin } from "./cli";
export { doctorPlugin } from "./doctor";
export { projectPlugin } from "./project";
export { tauriPlugin } from "./tauri";

// ─── Helpers ─────────────────────────────────────────────────
// The type namespaces below carry TYPES ONLY, so the one runtime value a plugin owns —
// the error class consumers `instanceof`-check — is re-exported by name here.
export { TauriError } from "./tauri/errors";

// ─── Plugin Types (type-only namespace re-exports) ───────────
// Consumers access types as: Project.Api, Tauri.DevHandle, etc.
export type * as Build from "./build/types";
export type * as Cli from "./cli/types";
export type * as Doctor from "./doctor/types";
export type * as Project from "./project/types";
export type * as Tauri from "./tauri/types";
