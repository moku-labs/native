/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/SpawnFn result
   shapes (`signal: string | null`, `code: number | null`), which stay `| null` per spec/02's
   Node-mirroring reconciliation — not a lazy `null` fallback (matches tauri's own tests). */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { NativeCompleteEvent, NativePhaseEvent } from "../../../../config";
import { coreConfig, createCore, createPlugin, PHASE_ORDER } from "../../../../config";
import { projectPlugin } from "../../../project";
import { tauriPlugin } from "../../../tauri";
import type { SpawnFn } from "../../../tauri/types";
import { buildPlugin } from "../../index";
import type { RunOptions } from "../../types";

// Scoped harness: composes project + tauri + build (build's real dependency graph — D-007),
// so this test never depends on sibling plugins (doctor/cli) being implemented.

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

/** A recorded `native:phase`/`native:complete` event, captured via a hook plugin. */
type RecordedEvent =
  | { name: "native:phase"; payload: NativePhaseEvent }
  | { name: "native:complete"; payload: NativeCompleteEvent };

/**
 * A fake `tauri` subprocess: emits a compile-tick line then a bundling-transition line
 * before resolving successfully — for every verb, including `icon`.
 */
const spawnBuildSucceeds: SpawnFn = async opts => {
  opts.onLine?.("[1/1] Compiling demo v0.1.0");
  opts.onLine?.("Bundling application (App.dmg)");
  return { code: 0, signal: null, stdout: "built", stderr: "" };
};

describe("build plugin integration", () => {
  let projectDir: string;
  let outDir: string;
  let spawnCalls: Array<readonly string[]>;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-build-integration-project-"));
    outDir = await mkdtemp(path.join(tmpdir(), "moku-native-build-integration-out-"));
    spawnCalls = [];
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  /** Composes a scoped app with a recorder hook plugin capturing every native:* event. */
  const createTestApp = (spawnImpl: SpawnFn, recordedEvents: RecordedEvent[]) => {
    const recordingSpawn: SpawnFn = spawnOpts => {
      spawnCalls.push(spawnOpts.cmd);
      return spawnImpl(spawnOpts);
    };
    const recorderPlugin = createPlugin("recorder", {
      hooks: () => ({
        "native:phase": payload => {
          recordedEvents.push({ name: "native:phase", payload });
        },
        "native:complete": payload => {
          recordedEvents.push({ name: "native:complete", payload });
        }
      })
    });
    const framework = createCore(coreConfig, {
      plugins: [projectPlugin, tauriPlugin, buildPlugin, recorderPlugin]
    });
    return framework.createApp({
      config: { ...validAppConfig, projectDir, outDir },
      pluginConfigs: { tauri: { spawnImpl: recordingSpawn, nodePath: "/usr/bin/node" } }
    });
  };

  /** The tauri verb (argv past the `[node, tauri.js]` prefix) of each recorded spawn. */
  const spawnVerbs = (): Array<readonly string[]> => spawnCalls.map(argv => argv.slice(2));

  describe("run", () => {
    it("emits the exact ordered event sequence and copies fixture artifacts to dist-native/<target>/", async () => {
      const dmgDir = path.join(projectDir, "src-tauri", "target", "release", "bundle", "dmg");
      await mkdir(dmgDir, { recursive: true });
      await writeFile(path.join(dmgDir, "App_1.0.0.dmg"), "dmg-bytes", "utf8");

      const recordedEvents: RecordedEvent[] = [];
      const app = createTestApp(spawnBuildSucceeds, recordedEvents);

      const result = await app.build.run({ target: "macos" });

      expect(result.target).toBe("macos");
      expect(result.outPath).toBe(path.join(outDir, "macos"));
      expect(result.artifacts).toEqual([path.join(outDir, "macos", "App_1.0.0.dmg")]);
      expect(existsSync(result.artifacts[0] as string)).toBe(true);
      expect(result.phases.map(phase => phase.phase)).toEqual([...PHASE_ORDER]);

      const phaseEvents = recordedEvents.filter(
        (event): event is Extract<RecordedEvent, { name: "native:phase" }> =>
          event.name === "native:phase"
      );
      expect(phaseEvents.map(event => `${event.payload.phase}:${event.payload.status}`)).toEqual([
        "scaffold:start",
        "scaffold:done",
        "codegen:start",
        "codegen:done",
        "icons:start",
        "icons:done",
        "compile:start",
        "compile:progress",
        "compile:done",
        "bundle:start",
        "bundle:done",
        "collect:start",
        "collect:done"
      ]);
      expect(phaseEvents.every(event => event.payload.target === "macos")).toBe(true);

      // No app.icon configured: the icons phase regenerates from the generated placeholder.
      const iconsDone = phaseEvents.find(
        event => event.payload.phase === "icons" && event.payload.status === "done"
      );
      expect(iconsDone?.payload.detail).toBe("placeholder");
      expect(existsSync(path.join(projectDir, "placeholder-icon.png"))).toBe(true);
      expect(spawnVerbs()).toEqual([
        [
          "icon",
          path.join(projectDir, "placeholder-icon.png"),
          "--output",
          path.join(projectDir, "src-tauri", "icons")
        ],
        ["build", "--ci"]
      ]);

      const completeEvents = recordedEvents.filter(event => event.name === "native:complete");
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]?.payload).toMatchObject({
        target: "macos",
        outPath: result.outPath,
        artifacts: result.artifacts
      });
    });

    it("zero matched artifacts fails the collect phase (no silent empty success)", async () => {
      const recordedEvents: RecordedEvent[] = [];
      const app = createTestApp(spawnBuildSucceeds, recordedEvents);

      await expect(app.build.run({ target: "macos" })).rejects.toThrow(
        /^\[native\] No macos installer artifacts found\./
      );

      const collectError = recordedEvents.find(
        event =>
          event.name === "native:phase" &&
          event.payload.phase === "collect" &&
          event.payload.status === "error"
      );
      expect(collectError?.payload).toMatchObject({ phase: "collect", status: "error" });
    });
  });

  describe("prepare", () => {
    it("runs scaffold/codegen/icons and stops — the build verb never spawns (M1)", async () => {
      const recordedEvents: RecordedEvent[] = [];
      const app = createTestApp(spawnBuildSucceeds, recordedEvents);

      await expect(app.build.prepare({ target: "macos" })).resolves.toBeUndefined();

      expect(
        recordedEvents.map(event =>
          event.name === "native:phase" ? `${event.payload.phase}:${event.payload.status}` : "done"
        )
      ).toEqual([
        "scaffold:start",
        "scaffold:done",
        "codegen:start",
        "codegen:done",
        "icons:start",
        "icons:done"
      ]);
      expect(existsSync(path.join(projectDir, "src-tauri", "tauri.conf.json"))).toBe(true);
      expect(spawnVerbs().map(verb => verb[0])).toEqual(["icon"]);
    });
  });

  describe("ios simulator", () => {
    it("initializes gen/apple after codegen, patches the runner, and collects the .app directory", async () => {
      const genAppleDir = path.join(projectDir, "src-tauri", "gen", "apple");

      const iosSpawn: SpawnFn = async opts => {
        const verb = opts.cmd.slice(2);

        if (verb[0] === "ios" && verb[1] === "init") {
          // `tauri ios init --ci` only runs once tauri.conf.json exists (B6).
          if (!existsSync(path.join(projectDir, "src-tauri", "tauri.conf.json"))) {
            throw new Error("ios init ran before codegen");
          }
          await mkdir(path.join(genAppleDir, "Sources"), { recursive: true });
          await mkdir(path.join(genAppleDir, "Assets.xcassets"), { recursive: true });
          await writeFile(
            path.join(genAppleDir, "project.yml"),
            "    script: node tauri ios xcode-script -v --platform iOS\n",
            "utf8"
          );
          await writeFile(path.join(genAppleDir, "ExportOptions.plist"), "<plist/>\n", "utf8");
          return { code: 0, signal: null, stdout: "initialized", stderr: "" };
        }

        if (verb[0] === "ios" && verb[1] === "build") {
          const simulatorDir = path.join(genAppleDir, "build", "arm64-sim", "Test App.app");
          await mkdir(simulatorDir, { recursive: true });
          await writeFile(path.join(simulatorDir, "Info.plist"), "<plist/>\n", "utf8");
          opts.onLine?.("Bundling application (Test App.app)");
          return { code: 0, signal: null, stdout: "built", stderr: "" };
        }

        return { code: 0, signal: null, stdout: "", stderr: "" };
      };

      const recordedEvents: RecordedEvent[] = [];
      const app = createTestApp(iosSpawn, recordedEvents);

      const result = await app.build.run({ target: "ios", simulator: true });

      // Verb order: codegen's init runs AFTER generate, icons regenerate because init ran.
      expect(spawnVerbs().map(verb => `${verb[0]} ${verb[1] ?? ""}`.trim())).toEqual([
        "ios init",
        `icon ${path.join(projectDir, "placeholder-icon.png")}`,
        "ios build"
      ]);

      // The build verb targets the host simulator arch (B7).
      const buildVerb = spawnVerbs().at(-1) ?? [];
      expect(buildVerb.includes("--target")).toBe(true);
      expect(buildVerb.at(-1)).toMatch(/-sim$/);

      // patchMobile received tauri.runner(): the bare `node tauri` command is gone.
      const projectYml = await readFile(path.join(genAppleDir, "project.yml"), "utf8");
      expect(projectYml).not.toContain("node tauri ios xcode-script");
      expect(projectYml).toContain('"/usr/bin/node"');

      // Collect took the simulator `.app` DIRECTORY (spaces in the name included).
      expect(result.artifacts).toEqual([path.join(outDir, "ios", "Test App.app")]);
      expect(existsSync(path.join(outDir, "ios", "Test App.app", "Info.plist"))).toBe(true);
    });
  });

  describe("runAll", () => {
    it("runs targets sequentially and stops at the first failing target", async () => {
      let buildCallCount = 0;
      const spawnFirstSucceedsThenFails: SpawnFn = async opts => {
        if (opts.cmd[2] !== "build") return { code: 0, signal: null, stdout: "", stderr: "" };
        buildCallCount += 1;
        if (buildCallCount === 1) {
          opts.onLine?.("Bundling application (App.dmg)");
          return { code: 0, signal: null, stdout: "built", stderr: "" };
        }
        return { code: 1, signal: null, stdout: "", stderr: "error: build failed" };
      };

      const dmgDir = path.join(projectDir, "src-tauri", "target", "release", "bundle", "dmg");
      await mkdir(dmgDir, { recursive: true });
      await writeFile(path.join(dmgDir, "App_1.0.0.dmg"), "dmg-bytes", "utf8");

      const recordedEvents: RecordedEvent[] = [];
      const app = createTestApp(spawnFirstSucceedsThenFails, recordedEvents);

      await expect(app.build.runAll({ targets: ["macos", "windows", "linux"] })).rejects.toThrow();

      // Exactly two build invocations: macos (succeeds), windows (fails) — linux is
      // never attempted (no partial-continue, v1).
      expect(buildCallCount).toBe(2);
    });
  });

  describe("types: API surface", () => {
    it("plugin name is the literal type 'build'", () => {
      expect(buildPlugin.name).toBe("build");
    });

    it("run() takes the extended RunOptions and rejects an invalid target at compile time", async () => {
      const app = createTestApp(spawnBuildSucceeds, []);
      expectTypeOf(app.build.run).parameter(0).toEqualTypeOf<RunOptions>();
      expectTypeOf(app.build.prepare)
        .parameter(0)
        .toEqualTypeOf<{ target: import("../../../../config").Target }>();
      // @ts-expect-error — "amiga" is not a valid Target
      await expect(app.build.run({ target: "amiga" })).rejects.toBeDefined();
    });

    it("app.emit accepts every NativePhase in PHASE_ORDER and rejects an unknown phase", () => {
      const app = createTestApp(spawnBuildSucceeds, []);
      expect(() =>
        app.emit("native:phase", { target: "macos", phase: "collect", status: "start" })
      ).not.toThrow();
      // @ts-expect-error — "lint" is not a NativePhase
      app.emit("native:phase", { target: "macos", phase: "lint", status: "start" });
    });

    it("native:complete payload matches its exact shape", () => {
      const app = createTestApp(spawnBuildSucceeds, []);
      expect(() =>
        app.emit("native:complete", {
          target: "macos",
          outPath: "dist-native/macos",
          artifacts: [],
          durationMs: 1
        })
      ).not.toThrow();
      // @ts-expect-error — native:complete has no `phase` field
      app.emit("native:complete", { target: "macos", phase: "collect" });
    });
  });
});
