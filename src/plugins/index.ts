// biome-ignore-all assist/source/organizeImports: two-section barrel layout (instances → type namespaces) is house style
/**
 * Plugin barrel — re-exports all framework plugin instances and types.
 * Helpers are NOT exported here — see src/index.ts.
 */

// ─── Plugin Instances ────────────────────────────────────────
export { buildPlugin } from "./build";
export { cliPlugin } from "./cli";
export { doctorPlugin } from "./doctor";
export { projectPlugin } from "./project";
export { tauriPlugin } from "./tauri";

// ─── Plugin Types (type-only namespace re-exports) ───────────
// Consumers access types as: Project.Api, Tauri.DevHandle, etc. The namespaces carry
// TYPES ONLY — the one runtime value (`TauriError`) is exported by name from src/index.ts.
export type * as Build from "./build/types";
export type * as Cli from "./cli/types";
export type * as Doctor from "./doctor/types";
export type * as Project from "./project/types";
export type * as Tauri from "./tauri/types";
