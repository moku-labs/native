/**
 * @file project plugin generator — capability-file permissions JSON for a target.
 */
import type { Target } from "../../../config";
import type { Artifact, GeneratorInput } from "./types";

/**
 * Tauri's capability `platforms` ids are not this framework's target ids: Apple's two are
 * camel-cased (`macOS`, `iOS`), the other three match. A wrong id makes Tauri silently
 * drop the whole capability file, so the mapping is explicit and total.
 */
const CAPABILITY_PLATFORM_ID: Record<Target, string> = {
  macos: "macOS",
  ios: "iOS",
  windows: "windows",
  linux: "linux",
  android: "android"
};

/**
 * Generates `src-tauri/capabilities/default.json` — `core:default` (the baseline Tauri
 * core permission set every app needs to open a window) followed by the permission ids
 * contributed by every capability resolved for this target. Capabilities are pre-filtered
 * (by `resolveConfiguredCapabilities` in `api.ts`) to rows whose `platforms` include the
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
  const permissions = [
    "core:default",
    ...input.capabilities.flatMap(capability => capability.permissions)
  ];

  const doc = {
    identifier: "default",
    description: "Auto-generated capability set for the composed system plugins.",
    windows: ["main"],
    platforms: [CAPABILITY_PLATFORM_ID[input.target]],
    permissions
  };

  return [
    {
      path: "src-tauri/capabilities/default.json",
      content: `${JSON.stringify(doc, undefined, 2)}\n`
    }
  ];
}
