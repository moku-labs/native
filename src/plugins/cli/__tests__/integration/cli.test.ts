/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/SpawnFn result
   shapes (`signal: string | null`, `code: number | null`), which stay `| null` per spec/02's
   Node-mirroring reconciliation (matches build/doctor/tauri's own tests). */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { buildPlugin } from "../../../build";
import { doctorPlugin } from "../../../doctor";
import type { ProbeFn } from "../../../doctor/types";
import { projectPlugin } from "../../../project";
import { tauriPlugin } from "../../../tauri";
import type { SpawnFn } from "../../../tauri/types";
import { cliPlugin } from "../../index";

// Full dependency graph (D-007): project + tauri + build + doctor + cli, so this test
// exercises cli's real wiring instead of reaching past it with mocks.
const framework = createCore(coreConfig, {
  plugins: [projectPlugin, tauriPlugin, buildPlugin, doctorPlugin, cliPlugin]
});

const validAppConfig = {
  app: { name: "Test App", identifier: "com.example.testapp" },
  web: {
    build: "bun run build",
    devCommand: "bun run dev",
    devUrl: "http://localhost:5173",
    dist: "dist"
  },
  system: [],
  capabilities: {}
};

/** A fake `tauri build` subprocess: emits a compile-tick line then a bundling-transition line. */
const spawnBuildSucceeds: SpawnFn = async opts => {
  opts.onLine?.("[1/1] Compiling demo v0.1.0");
  opts.onLine?.("Bundling application (App.dmg)");
  return { code: 0, signal: null, stdout: "built", stderr: "" };
};

/** A probe fake that succeeds every binary presence/version probe doctor issues. */
const probeAlwaysOk: ProbeFn = async cmd => ({
  code: 0,
  stdout: cmd === "rustup" ? "aarch64-apple-darwin" : "ok"
});

/** A fake dev subprocess that emits a readiness-looking line then exits cleanly (code 0). */
const spawnDevExitsZero: SpawnFn = async opts => {
  opts.onLine?.("Local:   http://localhost:5173/");
  return { code: 0, signal: null, stdout: "", stderr: "" };
};

/**
 * A fake subprocess where only `dev` exits non-zero (a crashed dev server) — the spawns
 * `build.prepare` issues beforehand (M1) still succeed.
 */
const spawnDevFails: SpawnFn = async opts =>
  opts.cmd.includes("dev")
    ? { code: 1, signal: null, stdout: "", stderr: "boom" }
    : { code: 0, signal: null, stdout: "", stderr: "" };

describe("cli plugin integration", () => {
  let projectDir: string;
  let outDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-cli-integration-project-"));
    outDir = await mkdtemp(path.join(tmpdir(), "moku-native-cli-integration-out-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  const createTestApp = (opts?: {
    renderImpl?: (line: string) => void;
    confirmImpl?: (question: string) => Promise<boolean>;
    spawnImpl?: SpawnFn;
    probeImpl?: ProbeFn;
  }) =>
    framework.createApp({
      config: { ...validAppConfig, projectDir, outDir, targets: ["macos"] },
      pluginConfigs: {
        tauri: { spawnImpl: opts?.spawnImpl ?? spawnBuildSucceeds, nodePath: "/usr/bin/node" },
        doctor: { probeImpl: opts?.probeImpl ?? probeAlwaysOk },
        cli: { renderImpl: opts?.renderImpl, confirmImpl: opts?.confirmImpl }
      }
    });

  describe("build", () => {
    it("renders the exact ordered native:phase/native:complete line sequence", async () => {
      const dmgDir = path.join(projectDir, "src-tauri", "target", "release", "bundle", "dmg");
      await mkdir(dmgDir, { recursive: true });
      await writeFile(path.join(dmgDir, "App_1.0.0.dmg"), "dmg-bytes", "utf8");

      const lines: string[] = [];
      const app = createTestApp({ renderImpl: line => lines.push(line) });

      await app.cli.build({ target: "macos" });

      const text = lines.join("\n");
      // Every pipeline phase (in order) shows up in the rendered output.
      const phaseIndices = ["scaffold", "codegen", "icons", "compile", "bundle", "collect"].map(
        phase => text.indexOf(phase)
      );
      expect(phaseIndices.every(index => index >= 0)).toBe(true);
      expect(phaseIndices).toEqual(phaseIndices.toSorted((a, b) => a - b));
      // The native:complete box renders the app name header, target, and artifact path.
      expect(text).toContain("Test App");
      expect(text).toContain("App_1.0.0.dmg");
    });

    it("rejects an invalid target at compile time (runtime: fails inside the pipeline)", async () => {
      const app = createTestApp();
      // @ts-expect-error — "amiga" is not a valid Target
      await expect(app.cli.build({ target: "amiga" })).rejects.toBeDefined();
    });
  });

  describe("doctor", () => {
    it("renders each check row ONCE plus a counts-only summary, and returns report.ok", async () => {
      const lines: string[] = [];
      const app = createTestApp({ renderImpl: line => lines.push(line) });

      const ok = await app.cli.doctor({ target: "macos" });

      expect(typeof ok).toBe("boolean");
      const text = lines.join("\n");
      // The live doctor:check hook prints the row; the summary never repeats it (M7).
      expect(lines.filter(line => line.includes("rustup-targets"))).toHaveLength(1);
      expect(text).toContain("Doctor summary");
      expect(text).toMatch(/pass \d+ · warn \d+ · fail \d+/);
    });
  });

  describe("dev", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("prepares the project (M1) then resolves once the fake dev process exits cleanly", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
      const app = createTestApp({ spawnImpl: spawnDevExitsZero });

      await expect(app.cli.dev()).resolves.toBeUndefined();

      // prepare ran before the dev process: the generated tree exists on disk.
      expect(existsSync(path.join(projectDir, "src-tauri", "tauri.conf.json"))).toBe(true);
      expect(existsSync(path.join(projectDir, "src-tauri", "build.rs"))).toBe(true);
    });

    it("rejects when the fake dev process exits non-zero", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
      const app = createTestApp({ spawnImpl: spawnDevFails });

      await expect(app.cli.dev()).rejects.toThrow(/tauri dev exited/);
    });
  });

  describe("clean", () => {
    it("without a target: aborts without deleting when confirm resolves false", async () => {
      const confirmImpl = vi.fn().mockResolvedValue(false);
      const app = createTestApp({ confirmImpl });

      await app.cli.clean();

      expect(confirmImpl).toHaveBeenCalledOnce();
      expect(existsSync(projectDir)).toBe(true);
    });
  });
});

describe("cli plugin — type-level", () => {
  it("plugin name is the literal type 'cli'", () => {
    expect(cliPlugin.name).toBe("cli");
  });

  it("exposes the typed verb surface on app.cli", () => {
    const app = framework.createApp({ config: validAppConfig });
    expectTypeOf(app.cli.build).toBeFunction();
    expectTypeOf(app.cli.dev).toBeFunction();
    expectTypeOf(app.cli.doctor).returns.resolves.toEqualTypeOf<boolean>();
    expectTypeOf(app.cli.clean).toBeFunction();
  });
});
