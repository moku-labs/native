/**
 * @file project plugin generator — the macOS App Store sandbox entitlements plist.
 */
import { relativeToTauriRoot } from "./paths";
import type { Artifact, GeneratorInput } from "./types";

/** Filename of the generated sandbox plist, written next to `tauri.conf.json`. */
const SANDBOX_ENTITLEMENTS_FILE = "Entitlements.plist";

/**
 * The minimum App Store sandbox: the sandbox itself, plus outbound network access (a
 * Tauri webview without it cannot reach its own dev/CDN origins).
 */
const SANDBOX_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  "<dict>",
  "  <key>com.apple.security.app-sandbox</key>",
  "  <true/>",
  "  <key>com.apple.security.network.client</key>",
  "  <true/>",
  "</dict>",
  "</plist>",
  ""
].join("\n");

/**
 * Whether this pass owns the entitlements file: an App Store macOS build that did not
 * supply its own plist. A consumer plist always wins, and iOS entitlements come from the
 * provisioning profile, never from here.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns Whether the sandbox plist should be generated.
 * @example
 * ```ts
 * generatesSandboxEntitlements({ global, target: "macos", capabilities: [] });
 * ```
 */
function generatesSandboxEntitlements(input: GeneratorInput): boolean {
  const apple = input.global.signing.apple;
  return apple?.appStore === true && !apple.entitlements && input.target === "macos";
}

/**
 * Resolves what `bundle.macOS.entitlements` should point at — a consumer-supplied plist
 * (rebased from the cwd onto `src-tauri`) or the generated sandbox plist.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns The POSIX entitlements path relative to `src-tauri`, or undefined when unsigned.
 * @example
 * ```ts
 * entitlementsPath({ global, target: "macos", capabilities: [] }); // "Entitlements.plist"
 * ```
 */
export function entitlementsPath(input: GeneratorInput): string | undefined {
  const consumerPlist = input.global.signing.apple?.entitlements;
  if (consumerPlist) return relativeToTauriRoot(input.global.projectDir, consumerPlist);
  if (generatesSandboxEntitlements(input)) return SANDBOX_ENTITLEMENTS_FILE;
  return undefined;
}

/**
 * Generates `src-tauri/Entitlements.plist` for an App Store macOS build that supplied no
 * entitlements file of its own. Every other configuration emits nothing.
 *
 * @param input - Frozen global config + capabilities resolved for the target.
 * @returns A single-artifact array, or an empty array when the consumer owns entitlements.
 * @example
 * ```ts
 * generateEntitlements({ global, target: "macos", capabilities: [] });
 * ```
 */
export function generateEntitlements(input: GeneratorInput): Artifact[] {
  if (!generatesSandboxEntitlements(input)) return [];
  return [{ path: `src-tauri/${SANDBOX_ENTITLEMENTS_FILE}`, content: SANDBOX_PLIST }];
}
