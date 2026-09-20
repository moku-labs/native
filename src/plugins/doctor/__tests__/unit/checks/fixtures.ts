import type { EnvApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { Config as GlobalConfig } from "../../../../../config";
import type { CheckInput } from "../../../checks/types";

/** A representative, minimal-but-valid global config fixture shared by every check test. */
export const baseGlobalConfig: Readonly<GlobalConfig> = {
  app: { name: "Test App", identifier: "com.example.testapp" },
  web: {
    build: "bun run build",
    devCommand: "bun run dev",
    devUrl: "http://localhost:5173",
    dist: "dist"
  },
  system: [],
  capabilities: {},
  targets: ["macos", "windows", "linux", "ios", "android"],
  projectDir: ".moku/tauri",
  outDir: "dist-native",
  signing: {}
};

/** Builds a fake `EnvApi` backed by a plain values map — `has`/`get` only see these keys. */
export function createEnv(values: Record<string, string> = {}): EnvApi {
  return {
    get: key => values[key],
    has: key => key in values,
    require: key => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`[native] missing required env var "${key}".`);
      }
      return value;
    },
    getPublic: () => ({ ...values }),
    getPublicMap: () => new Map(Object.entries(values))
  };
}

/**
 * Builds a fully-populated `CheckInput` fixture with sensible always-ok defaults, so each
 * test only needs to override the one seam it's exercising.
 *
 * @param overrides - Partial overrides merged shallowly over the defaults.
 * @returns A fresh `CheckInput`.
 */
export function createCheckInput(overrides?: Partial<CheckInput>): CheckInput {
  return {
    target: "host",
    global: baseGlobalConfig,
    probe: vi.fn(async () => ({ code: 0, stdout: "" })),
    fs: { readFile: vi.fn(async () => "{}") },
    env: createEnv(),
    project: {
      getRequiredFiles: vi.fn(() => []),
      getCompleteness: vi.fn(() => ({ status: "not-applicable" as const })),
      getRegistryRows: vi.fn(() => [])
    },
    tauri: {
      getVersion: vi.fn(async () => ({ cliVersion: "2.0.0" }))
    },
    ...overrides
  };
}
