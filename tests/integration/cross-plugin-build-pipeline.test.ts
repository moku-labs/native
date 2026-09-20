/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/SpawnFn result
   shapes (`signal: string | null`, `code: number | null`), which stay `| null` per spec/02's
   Node-mirroring reconciliation (matches the plugin integration tests). */
/**
 * @file Cross-plugin build pipeline integration (S05–S07): the build plugin orchestrating
 * project + tauri through the SHIPPED framework instance. S05 — `build.run` end-to-end on
 * macos: exact `native:phase` sequence, one `native:complete` matching the returned
 * `BuildResult`, real project codegen on disk, artifact collection, and the icons phase's
 * freshness skip (plus a direct `tauri.icon` call for API coverage). S06 — `build.runAll`
 * is sequential and stops at the first failing target (no partial-continue). S07 — the
 * mobile gate inside codegen: a `not-initialized` android tree triggers `tauri.mobileInit`
 * exactly once after codegen and before the build verb, the icon set is regenerated
 * because the init pass reset it, and codegen's `patchMobile` writes the Android signing
 * state.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Tauri } from "../../src/index";
import { PHASE_ORDER } from "../../src/index";
import type { RecordedEvent, TestApp } from "./helpers/create-test-app";
import { createTestApp } from "./helpers/create-test-app";
import { spawnBuildSucceeds, spawnFailsWith, spawnSequence } from "./helpers/fixtures";

/** A recorded `native:phase` event (the recorder plugin's union member for phases). */
type PhaseEvent = Extract<RecordedEvent, { name: "native:phase" }>;

/**
 * Extracts the `native:phase` events, narrowed, in emission order.
 *
 * @param events - The recorder plugin's captured events.
 * @returns Only the `native:phase` events.
 */
function phaseEvents(events: readonly RecordedEvent[]): PhaseEvent[] {
  return events.filter((event): event is PhaseEvent => event.name === "native:phase");
}

/**
 * Projects recorded phase events into `"phase:status"` keys, in emission order.
 *
 * @param events - The recorder plugin's captured events.
 * @returns One `"phase:status"` key per `native:phase` event.
 */
function phaseKeys(events: readonly RecordedEvent[]): string[] {
  return phaseEvents(events).map(event => `${event.payload.phase}:${event.payload.status}`);
}

/**
 * The exact `native:phase` sequence a successful single-target pipeline emits with the
 * shared two-line spawn fake (one compile tick + one bundling-transition line):
 * six phases × start…done, plus the single compile progress tick.
 */
const SUCCESS_PHASE_SEQUENCE = [
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
];

describe("cross-plugin build pipeline (S05–S07)", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  describe("S05 — build.run orchestrates project + tauri end-to-end", () => {
    it("emits the exact ordered phase sequence, one native:complete matching the BuildResult, and really delegates codegen + collect", async () => {
      testApp = await createTestApp();
      const { app, projectDir, outDir, events, spawnCalls } = testApp;
      await testApp.seedMacosArtifact();

      const result = await app.build.run({ target: "macos" });

      // Exact ordered native:phase sequence — every phase start…done, in PHASE_ORDER.
      expect(phaseKeys(events)).toEqual(SUCCESS_PHASE_SEQUENCE);
      expect(phaseEvents(events).every(event => event.payload.target === "macos")).toBe(true);

      // compile:progress carries the REAL parsed tick detail (crate + N/M counts).
      const progressEvent = phaseEvents(events).find(event => event.payload.status === "progress");
      expect(progressEvent?.payload.phase).toBe("compile");
      expect(progressEvent?.payload.detail).toBe("Compiling demo 1/1");

      // The icons phase sees a generated set newer than the configured source, so it
      // reports "up to date" and never spawns the icon verb (B5/A8).
      const iconsDone = phaseEvents(events).find(
        event => event.payload.phase === "icons" && event.payload.status === "done"
      );
      expect(iconsDone?.payload.detail).toBe("up to date");

      // Exactly one native:complete, payload matching the returned BuildResult.
      const completeEvents = events.filter(event => event.name === "native:complete");
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]?.payload).toEqual({
        target: "macos",
        outPath: result.outPath,
        artifacts: result.artifacts,
        durationMs: result.durationMs
      });

      // The BuildResult covers all six phases in canonical order.
      expect(result.phases.map(phase => phase.phase)).toEqual([...PHASE_ORDER]);

      // Artifacts copied into outDir/macos/ — the stable delivery location.
      expect(result.outPath).toBe(path.join(outDir, "macos"));
      expect(result.artifacts).toEqual([path.join(outDir, "macos", "App_1.0.0.dmg")]);
      expect(existsSync(path.join(outDir, "macos", "App_1.0.0.dmg"))).toBe(true);

      // Cross-plugin delegation is real: project generated the tree during codegen.
      expect(existsSync(path.join(projectDir, "src-tauri", "tauri.conf.json"))).toBe(true);
      expect(existsSync(path.join(projectDir, "src-tauri", "Cargo.toml"))).toBe(true);
      expect(existsSync(path.join(projectDir, "src-tauri", "capabilities", "default.json"))).toBe(
        true
      );

      // Exactly ONE subprocess — the desktop build verb (compile+bundle share it, D-013).
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.argv[0]).toBe("/usr/bin/node");
      expect(spawnCalls[0]?.argv[1]).toMatch(/@tauri-apps\/cli\/tauri\.js$/);
      expect(spawnCalls[0]?.argv.slice(2)).toEqual(["build", "--ci"]);
    });

    it("app.tauri.icon spawns the icon verb directly (pipeline API coverage for the never-spawned icons phase)", async () => {
      testApp = await createTestApp();
      const { app, projectDir, spawnCalls } = testApp;

      const result = await app.tauri.icon({ source: "assets/icon.png" });

      expect(result.code).toBe(0);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.argv[0]).toBe("/usr/bin/node");
      expect(spawnCalls[0]?.argv.slice(2)).toEqual([
        "icon",
        "assets/icon.png",
        "--output",
        path.join(projectDir, "src-tauri", "icons")
      ]);
    });
  });

  describe("S06 — build.runAll is sequential and stops at the first failing target", () => {
    it("rejects on the second target, never attempts the third, and completes only the first", async () => {
      testApp = await createTestApp({
        spawnImpl: spawnSequence(spawnBuildSucceeds, spawnFailsWith("error: build failed"))
      });
      const { app, events, spawnCalls } = testApp;
      await testApp.seedMacosArtifact();

      await expect(app.build.runAll({ targets: ["macos", "windows", "linux"] })).rejects.toThrow(
        /^\[native\] tauri /
      );

      // Exactly two subprocess invocations: macos (succeeds), windows (fails) — linux is
      // never attempted (no partial-continue, v1). Both are the desktop build verb.
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls.map(call => call.argv.slice(2))).toEqual([
        ["build", "--ci"],
        ["build", "--ci"]
      ]);

      // The failure surfaces as ONE native:phase error, attributed to windows' compile.
      const errorPhases = phaseEvents(events).filter(event => event.payload.status === "error");
      expect(errorPhases).toHaveLength(1);
      expect(errorPhases[0]?.payload).toMatchObject({
        target: "windows",
        phase: "compile",
        status: "error"
      });
      expect(errorPhases[0]?.payload.detail).toMatch(/^\[native\] tauri /);

      // Exactly one native:complete — macos only — emitted BEFORE the windows error.
      const completeEvents = events.filter(event => event.name === "native:complete");
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]?.payload.target).toBe("macos");
      const completeIndex = events.findIndex(event => event.name === "native:complete");
      const errorIndex = events.findIndex(
        event => event.name === "native:phase" && event.payload.status === "error"
      );
      expect(completeIndex).toBeGreaterThan(-1);
      expect(completeIndex).toBeLessThan(errorIndex);

      // linux never entered the pipeline — no phase event ever mentions it.
      expect(phaseEvents(events).some(event => event.payload.target === "linux")).toBe(false);
    });
  });

  describe("S07 — mobile gate in codegen: not-initialized → tauri.mobileInit → patchMobile", () => {
    it("initializes gen/android once before the build verb and patches Android signing state", async () => {
      // Captured at runtime from the project API — the fixture set is never hardcoded.
      let requiredAndroidFiles: readonly string[] | undefined;
      // Completeness observed from INSIDE the build verb — proves the flip happened
      // between the init spawn and the build spawn, not merely by the end of the run.
      let completenessAtBuildVerb: { status: string } | undefined;

      /**
       * An argv-dispatching spawn fake: the `android init` verb fabricates the full
       * `requiredFiles("android")` tree (mirroring what `tauri android init` scaffolds);
       * the `android build` verb drops the finished `.apk` where collect globs for it.
       *
       * @param opts - The SpawnFn options (cwd is the app's projectDir).
       * @returns A resolved success result for the recognized verbs.
       */
      const androidSpawn: Tauri.SpawnFn = async opts => {
        const verb = opts.cmd.slice(2);
        const genDir = path.join(opts.cwd, "src-tauri", "gen", "android");

        if (verb[0] === "android" && verb[1] === "init") {
          if (!requiredAndroidFiles) throw new Error("requiredFiles not captured before init");
          for (const file of requiredAndroidFiles) {
            const fullPath = path.join(genDir, file);
            await mkdir(path.dirname(fullPath), { recursive: true });
            const content = file.endsWith("build.gradle.kts") ? "plugins {\n}\n" : "generated\n";
            await writeFile(fullPath, content, "utf8");
          }
          return { code: 0, signal: null, stdout: "initialized", stderr: "" };
        }

        if (verb[0] === "icon") {
          return { code: 0, signal: null, stdout: "icons generated", stderr: "" };
        }

        if (verb[0] === "android" && verb[1] === "build") {
          completenessAtBuildVerb = testApp?.app.project.getCompleteness({ target: "android" });
          const apkPath = path.join(
            genDir,
            "app",
            "build",
            "outputs",
            "apk",
            "universal",
            "release",
            "app-universal-release.apk"
          );
          await mkdir(path.dirname(apkPath), { recursive: true });
          await writeFile(apkPath, "apk-bytes", "utf8");
          opts.onLine?.("[1/1] Compiling demo v0.1.0");
          opts.onLine?.("Bundling application (app-universal-release.apk)");
          return { code: 0, signal: null, stdout: "built", stderr: "" };
        }

        throw new Error(`unexpected tauri verb: ${verb.join(" ")}`);
      };

      testApp = await createTestApp({
        config: {
          signing: {
            android: {
              keystorePath: "release.jks",
              // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- an env-var *name* reference, never a secret (SigningConfig invariant)
              keystorePasswordEnv: "MOKU_TEST_KS_PASSWORD",
              keyAlias: "release"
            }
          }
        },
        spawnImpl: androidSpawn
      });
      const { app, projectDir, outDir, events, spawnCalls } = testApp;

      requiredAndroidFiles = app.project.getRequiredFiles({ target: "android" });
      expect(requiredAndroidFiles.length).toBeGreaterThan(0);

      // The gate's starting point: no gen/android tree at all.
      expect(app.project.getCompleteness({ target: "android" })).toEqual({
        status: "not-initialized"
      });

      const result = await app.build.run({ target: "android" });

      // Spawn call order: mobileInit (inside codegen) → icon regeneration (the fresh gen/
      // tree ships Tauri's own defaults, B5/A8) → the build verb. Nothing else ran.
      expect(spawnCalls).toHaveLength(3);
      expect(spawnCalls[0]?.argv[0]).toBe("/usr/bin/node");
      expect(spawnCalls[0]?.argv.slice(2)).toEqual(["android", "init", "--ci"]);
      expect(spawnCalls[1]?.argv.slice(2, 3)).toEqual(["icon"]);
      expect(spawnCalls[2]?.argv.slice(2)).toEqual(["android", "build", "--ci", "--apk"]);

      // Completeness flipped not-initialized → complete after init, before the build verb.
      expect(completenessAtBuildVerb).toEqual({ status: "complete" });
      expect(app.project.getCompleteness({ target: "android" })).toEqual({ status: "complete" });

      // codegen ran patchMobile: signing lives in Gradle only — no keystore.properties (A11).
      expect(
        existsSync(path.join(projectDir, "src-tauri", "gen", "android", "keystore.properties"))
      ).toBe(false);

      // ...and the sentinel-delimited block carries env-var REFERENCES only.
      const buildGradle = await readFile(
        path.join(projectDir, "src-tauri", "gen", "android", "app", "build.gradle.kts"),
        "utf8"
      );
      expect(buildGradle).toContain("// MOKU-SIGNING-START");
      expect(buildGradle).toContain("// MOKU-SIGNING-END");
      expect(buildGradle).toContain('keyAlias = "release"');
      expect(buildGradle).toContain('storeFile = file("release.jks")');
      expect(buildGradle).toContain('storePassword = System.getenv("MOKU_TEST_KS_PASSWORD")');
      expect(buildGradle).toContain('keyPassword = System.getenv("MOKU_TEST_KS_PASSWORD")');

      // The full pipeline still reported every phase and delivered the apk.
      expect(phaseKeys(events)).toEqual(SUCCESS_PHASE_SEQUENCE);
      expect(phaseEvents(events).every(event => event.payload.target === "android")).toBe(true);
      const completeEvents = events.filter(event => event.name === "native:complete");
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]?.payload.target).toBe("android");
      expect(result.artifacts).toEqual([path.join(outDir, "android", "app-universal-release.apk")]);
      expect(existsSync(path.join(outDir, "android", "app-universal-release.apk"))).toBe(true);
    });
  });
});
