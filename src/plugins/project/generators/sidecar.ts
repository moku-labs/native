/**
 * @file project plugin generator — Info.ios.plist sidecar (src-tauri root, outside gen/).
 */
import type { Artifact, GeneratorInput } from "./types";

/**
 * Generates the `Info.ios.plist` SIDECAR at the src-tauri root — a future-mechanism
 * seam for iOS mobile-permission plist keys (D-012). Every v1 registry row carries an
 * empty `sidecarPlist`, so this emits no artifact today; it stays pure and
 * generator-shaped so a future row carrying `sidecarPlist` entries activates it with
 * zero pipeline changes.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns An artifact for `src-tauri/Info.ios.plist` when any resolved capability
 *   carries sidecar entries, otherwise an empty array.
 * @example
 * ```ts
 * generateSidecar({ global, target: "ios", capabilities: [] }); // []
 * ```
 */
export function generateSidecar(input: GeneratorInput): Artifact[] {
  const entries = input.capabilities.flatMap(capability => capability.sidecarPlist);
  if (entries.length === 0) return [];

  const body = entries
    .map(entry => `  <key>${entry.key}</key>\n  <string>${entry.value}</string>`)
    .join("\n");

  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    body,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");

  return [{ path: "src-tauri/Info.ios.plist", content }];
}
