import type { Config } from "../../../../../config";
import type { GeneratorInput } from "../../../generators/types";
import { resolve } from "../../../registry";

/** A representative, fully-populated global config fixture for golden-file generator tests. */
export const baseGlobalConfig: Readonly<Config> = {
  app: { name: "My Cool App", identifier: "com.example.mycoolapp", version: "1.2.3" },
  web: {
    build: "bun run build",
    devCommand: "bun run dev",
    devUrl: "http://localhost:5173",
    dist: "dist"
  },
  system: [
    { name: "store" },
    { name: "notification" },
    { name: "clipboard-manager" },
    { name: "tray" },
    { name: "deep-link" }
  ],
  capabilities: { "deep-link": { mode: "scheme", scheme: "mycoolapp" } },
  targets: ["macos", "windows", "linux", "ios", "android"],
  projectDir: ".moku/tauri",
  outDir: "dist-native",
  signing: {}
};

/**
 * All 5 capabilities resolved, exactly as `resolveConfiguredCapabilities` would produce
 * for `target` (platform-filtered).
 */
export function resolvedCapabilitiesFor(target: GeneratorInput["target"]) {
  return [
    resolve("store"),
    resolve("notification"),
    resolve("clipboard-manager"),
    resolve("tray"),
    resolve("deep-link", { mode: "scheme", scheme: "mycoolapp" })
  ].filter(capability => capability.platforms.includes(target));
}

/** Builds a `GeneratorInput` fixture for a given target, with all 5 capabilities composed. */
export function generatorInputFor(target: GeneratorInput["target"]): GeneratorInput {
  return { global: baseGlobalConfig, target, capabilities: resolvedCapabilitiesFor(target) };
}
