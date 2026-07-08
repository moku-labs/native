/**
 * @file project plugin generator — capability-file permissions JSON for a target.
 */
import type { Artifact, GeneratorInput } from "./types";

/**
 * Generates `src-tauri/capabilities/default.json` — the permission ids contributed by
 * every capability resolved for this target. Capabilities are pre-filtered (by
 * `resolveConfiguredCapabilities` in `api.ts`) to rows whose `platforms` include the
 * target, so a desktop-only row like tray is naturally absent from a mobile target-set.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns A single-artifact array for `src-tauri/capabilities/default.json`.
 * @example
 * ```ts
 * generateCapabilities({ global, target: "ios", capabilities: [] });
 * ```
 */
export function generateCapabilities(input: GeneratorInput): Artifact[] {
  const permissions = input.capabilities.flatMap(capability => capability.permissions);

  const doc = {
    identifier: "default",
    description: "Auto-generated capability set for the composed system plugins.",
    windows: ["main"],
    platforms: [input.target],
    permissions
  };

  return [
    {
      path: "src-tauri/capabilities/default.json",
      content: `${JSON.stringify(doc, undefined, 2)}\n`
    }
  ];
}
