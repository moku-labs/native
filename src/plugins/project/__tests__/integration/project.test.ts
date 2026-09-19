import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { coreConfig, createCore } from "../../../../config";
import { projectPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Complex tier: project plugin (integration)
// ---------------------------------------------------------------------------

const validAppConfig = {
  app: { name: "Test App", identifier: "com.example.testapp" },
  web: {
    build: "bun run build",
    devCommand: "bun run dev",
    devUrl: "http://localhost:5173",
    dist: "dist"
  },
  system: [{ name: "store" }, { name: "deep-link" }],
  capabilities: { "deep-link": { mode: "scheme" as const, scheme: "testapp" } }
};

describe("complex tier: project plugin (integration)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-project-integration-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  const createTestApp = () => {
    const framework = createCore(coreConfig, { plugins: [projectPlugin] });
    return framework.createApp({ config: { ...validAppConfig, projectDir } });
  };

  // -------------------------------------------------------------------------
  // Runtime: generate writes the full tree
  // -------------------------------------------------------------------------

  describe("runtime: generate", () => {
    it("writes the full pure artifact tree for a desktop target", async () => {
      const app = createTestApp();

      const result = await app.project.generate({ target: "macos" });

      expect(result.written.length).toBeGreaterThan(0);
      expect(existsSync(path.join(projectDir, "src-tauri", "tauri.conf.json"))).toBe(true);
      expect(existsSync(path.join(projectDir, "src-tauri", "Cargo.toml"))).toBe(true);
      expect(existsSync(path.join(projectDir, "src-tauri", "src", "lib.rs"))).toBe(true);
      expect(existsSync(path.join(projectDir, "src-tauri", "src", "main.rs"))).toBe(true);
      expect(existsSync(path.join(projectDir, "src-tauri", "capabilities", "default.json"))).toBe(
        true
      );
    });

    it("second run reports all-unchanged, preserving mtime", async () => {
      const app = createTestApp();
      await app.project.generate({ target: "macos" });

      const confPath = path.join(projectDir, "src-tauri", "tauri.conf.json");
      const before = await stat(confPath);

      const second = await app.project.generate({ target: "macos" });
      const after = await stat(confPath);

      expect(second.written).toEqual([]);
      expect(second.unchanged.length).toBeGreaterThan(0);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it("mobile generate does not create the gen/ tree", async () => {
      const app = createTestApp();

      await app.project.generate({ target: "ios" });

      expect(existsSync(path.join(projectDir, "src-tauri", "gen"))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Runtime: completeness / clean
  // -------------------------------------------------------------------------

  describe("runtime: completeness and clean", () => {
    it("completeness reports not-initialized before any mobile init", async () => {
      const app = createTestApp();
      expect(app.project.completeness({ target: "android" })).toEqual({
        status: "not-initialized"
      });
    });

    it("clean removes the generated tree", async () => {
      const app = createTestApp();
      await app.project.generate({ target: "macos" });

      const result = await app.project.clean();

      expect(existsSync(projectDir)).toBe(false);
      expect(result.removed).toEqual([projectDir]);
    });
  });

  // -------------------------------------------------------------------------
  // Runtime: config validation
  // -------------------------------------------------------------------------

  describe("runtime: config validation failures", () => {
    it("throws a [native]-prefixed error for a missing identifier", () => {
      const framework = createCore(coreConfig, { plugins: [projectPlugin] });

      expect(() =>
        framework.createApp({
          config: {
            app: { name: "Test App", identifier: "" },
            web: validAppConfig.web,
            system: [],
            capabilities: {},
            projectDir
          }
        })
      ).toThrow(/^\[native\]/);
    });

    it("throws for an unknown config.system capability name", () => {
      const framework = createCore(coreConfig, { plugins: [projectPlugin] });

      expect(() =>
        framework.createApp({
          config: {
            app: { name: "Test App", identifier: "com.example.testapp" },
            web: validAppConfig.web,
            system: [{ name: "bogus-capability" }],
            capabilities: {},
            projectDir
          }
        })
      ).toThrow('[native] Unknown capability "bogus-capability"');
    });

    it("throws when deep-link is composed without a scheme", () => {
      const framework = createCore(coreConfig, { plugins: [projectPlugin] });

      expect(() =>
        framework.createApp({
          config: {
            app: { name: "Test App", identifier: "com.example.testapp" },
            web: validAppConfig.web,
            system: [{ name: "deep-link" }],
            capabilities: {},
            projectDir
          }
        })
      ).toThrow("[native] deep-link is composed in config.system");
    });

    it("succeeds with a fully valid config", () => {
      expect(() => createTestApp()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Types: API surface
  // -------------------------------------------------------------------------

  describe("types: API surface", () => {
    it("plugin name is the literal type 'project'", () => {
      expect(projectPlugin.name).toBe("project");
    });

    it("exposes registryRows and requiredFiles for doctor", () => {
      const app = createTestApp();
      expect(app.project.registryRows()).toHaveLength(5);
      expect(app.project.requiredFiles("android").length).toBeGreaterThan(0);
    });
  });
});
