import type { EnvApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { Config as GlobalConfig } from "../../../../../config";
import { resolveDebugKeystore } from "../../../../project/mobile/signing";
import type { CheckInput, CheckProjectApi, FsFacade } from "../../../checks/types";

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

/** A fake file tree: file paths mapped to their text, directory paths mapped to their entry names. */
export type FakeTree = {
  files?: Readonly<Record<string, string>>;
  directories?: Readonly<Record<string, readonly string[]>>;
};

/**
 * Builds a fake `FsFacade` over a fixed tree. A path outside the tree does not exist:
 * `readFile`/`readdir` reject on it (as the real facade does) and `exists` answers `false`.
 *
 * @param tree - The files and directories the fake knows.
 * @returns A fresh fake facade.
 */
export function createFs(tree: FakeTree = {}): FsFacade {
  const files = tree.files ?? {};
  const directories = tree.directories ?? {};
  return {
    readFile: vi.fn(async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return text;
    }),
    exists: vi.fn(async (path: string) => path in files || path in directories),
    readdir: vi.fn(async (path: string) => {
      const entries = directories[path];
      if (entries === undefined) throw new Error(`ENOENT: no such directory, scandir '${path}'`);
      return [...entries];
    })
  };
}

/** `createCheckInput` overrides: every seam replaceable, `fs` and `project` one member at a time. */
export type CheckInputOverrides = Omit<Partial<CheckInput>, "fs" | "project"> & {
  fs?: Partial<FsFacade>;
  project?: Partial<CheckProjectApi>;
};

/**
 * Builds a fully-populated `CheckInput` fixture with sensible always-ok defaults, so each
 * test only needs to override the one seam it's exercising. An `fs` or `project` override
 * replaces only the members it names (a test that reads files need not fake `exists`/`readdir`).
 *
 * @param overrides - Partial overrides merged shallowly over the defaults.
 * @returns A fresh `CheckInput`.
 */
export function createCheckInput(overrides: CheckInputOverrides = {}): CheckInput {
  const { fs, project, ...rest } = overrides;
  const env = rest.env ?? createEnv();
  return {
    target: "host",
    global: baseGlobalConfig,
    probe: vi.fn(async () => ({ code: 0, stdout: "" })),
    fs: {
      readFile: vi.fn(async () => "{}"),
      exists: vi.fn(async () => false),
      readdir: vi.fn(async () => []),
      ...fs
    },
    env,
    project: {
      getRequiredFiles: vi.fn(() => []),
      getCompleteness: vi.fn(() => ({ status: "not-applicable" as const })),
      getRegistryRows: vi.fn(() => []),
      // The real rule, over the same fake env the check input carries.
      getDebugKeystore: vi.fn(() => resolveDebugKeystore(env)),
      ...project
    },
    tauri: {
      getVersion: vi.fn(async () => ({ cliVersion: "2.0.0" }))
    },
    ...rest
  };
}
