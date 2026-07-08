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

// ─── Plugin Types (namespace re-exports) ─────────────────────
// Consumers access types as: Project.Api, Tauri.DevHandle, etc.
export * as Build from "./build/types";
export * as Cli from "./cli/types";
export * as Doctor from "./doctor/types";
export * as Project from "./project/types";
export * as Tauri from "./tauri/types";
