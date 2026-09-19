/**
 * @file Root integration — core framework boot (scenarios S01–S04).
 *
 * S01 — Framework boots via package-entry createApp with all five plugin APIs.
 * S02 — Global-config defaults + partial override composition (incl. MC1 render seam).
 * S03 — project.onInit validates app identity at createApp time (not at first verb).
 * S04 — Consumer plugin composes into the chain with ctx.log/ctx.env present.
 * S20 — env core plugin resolves real host variables; targets default to the host's own.
 *
 * All apps compose through the SHIPPED package entry (`src/index.ts`) — never a
 * `createCore` re-composition — with every subprocess/render seam injected.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Doctor, NativePhaseEvent, Target } from "../../src/index";
import { createApp, createPlugin, hostTargets } from "../../src/index";
import { createTestApp, VALID_APP_CONFIG } from "./helpers/create-test-app";
import { spawnBuildSucceeds } from "./helpers/fixtures";

/** Deferred teardown closures — every scenario registers its temp-dir/app cleanup here. */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/**
 * Creates a fresh temp projectDir/outDir pair for manually composed apps (S02–S04)
 * and registers their removal with the shared afterEach teardown.
 *
 * @returns The two absolute temp directory paths.
 */
async function makeTempDirs(): Promise<{ projectDir: string; outDir: string }> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-root-project-"));
  const outDir = await mkdtemp(path.join(tmpdir(), "moku-native-root-out-"));

  cleanups.push(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });
  return { projectDir, outDir };
}

/**
 * Seeds the macos `.dmg` bundle fixture the collect phase globs for (manual-composition
 * mirror of the helper's `seedMacosArtifact`).
 *
 * @param projectDir - The app's temp project directory.
 * @returns The absolute path of the seeded artifact.
 */
async function seedDmgFixture(projectDir: string): Promise<string> {
  const dmgDir = path.join(projectDir, "src-tauri", "target", "release", "bundle", "dmg");
  await mkdir(dmgDir, { recursive: true });

  const artifactPath = path.join(dmgDir, "App_1.0.0.dmg");
  await writeFile(artifactPath, "dmg-bytes", "utf8");
  return artifactPath;
}

describe("S01 — framework boots via package-entry createApp with all five plugin APIs", () => {
  it("composes project → tauri → build → doctor → cli and survives start/stop", async () => {
    const testApp = await createTestApp();
    cleanups.push(() => testApp.cleanup());
    const { app } = testApp;

    // Lifecycle: the composed Layer-3 app starts and stops cleanly.
    await app.start();
    await app.stop();

    // project — capability registry + generators + writer + clean.
    expect(app.project.generate).toBeTypeOf("function");
    expect(app.project.completeness).toBeTypeOf("function");
    expect(app.project.patchMobile).toBeTypeOf("function");
    expect(app.project.clean).toBeTypeOf("function");
    expect(app.project.resolve).toBeTypeOf("function");
    expect(app.project.isKnownCapability).toBeTypeOf("function");
    expect(app.project.registryRows).toBeTypeOf("function");
    expect(app.project.requiredFiles).toBeTypeOf("function");

    // tauri — the @tauri-apps/cli subprocess surface.
    expect(app.tauri.icon).toBeTypeOf("function");
    expect(app.tauri.build).toBeTypeOf("function");
    expect(app.tauri.mobileInit).toBeTypeOf("function");
    expect(app.tauri.dev).toBeTypeOf("function");
    expect(app.tauri.version).toBeTypeOf("function");

    // build + doctor + cli — orchestrator, diagnosis, and verb surface.
    expect(app.build.run).toBeTypeOf("function");
    expect(app.build.runAll).toBeTypeOf("function");
    expect(app.doctor.run).toBeTypeOf("function");
    expect(app.cli.build).toBeTypeOf("function");
    expect(app.cli.dev).toBeTypeOf("function");
    expect(app.cli.doctor).toBeTypeOf("function");
    expect(app.cli.clean).toBeTypeOf("function");

    // Representative signatures stay precisely typed through Layer 3.
    expectTypeOf(app.doctor.run).returns.resolves.toEqualTypeOf<Doctor.DoctorReport>();
    expectTypeOf(app.cli.doctor).returns.resolves.toEqualTypeOf<boolean>();

    // app.emit is typed against the global Events map.
    expect(() =>
      app.emit("native:phase", { target: "macos", phase: "scaffold", status: "start" })
    ).not.toThrow();
    // @ts-expect-error — "native:unknown" is not a declared framework event
    app.emit("native:unknown", {});
  });
});

describe("S02 — global-config defaults + partial override composition", () => {
  it("generates under the overridden projectDir with default web wiring, MC1-clean", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    // Override ONLY dirs/targets/app identity — web wiring must come from defaultConfig.
    const rendered: string[] = [];
    const app = createApp({
      config: {
        app: { name: "Test App", identifier: "com.example.testapp" },
        projectDir,
        outDir,
        targets: ["macos"]
      },
      pluginConfigs: {
        tauri: { spawnImpl: spawnBuildSucceeds, nodePath: "/usr/bin/node" },
        cli: {
          renderImpl: (line: string) => {
            rendered.push(line);
          }
        }
      }
    });

    // The generated tree lands under the OVERRIDDEN projectDir.
    const result = await app.project.generate({ target: "macos" });
    const confPath = path.join(projectDir, "src-tauri", "tauri.conf.json");
    expect(existsSync(confPath)).toBe(true);
    expect(result.written).toContain(confPath);

    // Content reflects the framework's DEFAULT web wiring (web was never configured).
    const conf = JSON.parse(await readFile(confPath, "utf8")) as {
      productName: string;
      build: {
        beforeBuildCommand: { script: string; cwd: string };
        devUrl: string;
        frontendDist: string;
      };
    };
    expect(conf.productName).toBe("Test App");
    expect(conf.build.beforeBuildCommand.script).toBe("bun run build");
    expect(conf.build.beforeBuildCommand.cwd).toBe(path.resolve("."));
    expect(conf.build.devUrl).toBe("http://localhost:5173");
    // frontendDist is resolved FROM src-tauri, where Tauri reads it (B4).
    expect(conf.build.frontendDist).toBe(
      path.relative(path.join(projectDir, "src-tauri"), path.resolve("dist")).replaceAll("\\", "/")
    );

    // pluginConfigs seam layering: the framework default `cli.renderImpl: undefined` is
    // replaced by the injected sink — the CLI renders there, never via raw console (MC1).
    // ctx.log's structured records (plain objects) are the logging seam, not CLI UI, so
    // the spy asserts no rendered STRING line ever reached raw console.log.
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await seedDmgFixture(projectDir);
    await app.cli.build({ target: "macos" });

    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.join("\n")).toContain("Test App — macos build complete");
    const rawStringUiCalls = consoleSpy.mock.calls.filter(call => typeof call[0] === "string");
    expect(rawStringUiCalls).toEqual([]);
  });
});

describe("S03 — project.onInit validates app identity at createApp time", () => {
  it("rejects a non-reverse-DNS identifier synchronously at composition", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    const compose = () =>
      createApp({
        config: {
          ...VALID_APP_CONFIG,
          app: { name: "Test App", identifier: "notreversedns" },
          projectDir,
          outDir,
          targets: ["macos"]
        }
      });

    // Throws AT createApp — before any verb runs — in the [native] actionable format.
    expect(compose).toThrow(/^\[native\] app\.identifier "notreversedns" is not a valid/);
    expect(compose).toThrow(/Use a reverse-DNS identifier such as "com\.example\.myapp"/);
  });

  it("rejects an empty app.name synchronously at composition", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    const compose = () =>
      createApp({
        config: {
          ...VALID_APP_CONFIG,
          app: { name: "", identifier: "com.example.testapp" },
          projectDir,
          outDir,
          targets: ["macos"]
        }
      });

    expect(compose).toThrow(/^\[native\] app\.name is required\./);
    expect(compose).toThrow(/Set config\.app\.name to your app's display name\./);
  });

  it("composes the valid control config without throwing", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    expect(() =>
      createApp({
        config: { ...VALID_APP_CONFIG, projectDir, outDir, targets: ["macos"] },
        pluginConfigs: { tauri: { spawnImpl: spawnBuildSucceeds, nodePath: "/usr/bin/node" } }
      })
    ).not.toThrow();
  });
});

describe("S04 — consumer plugin composes into the chain with ctx.log/ctx.env present", () => {
  it("gives the observer plugin functioning ctx.log/ctx.env and a seat on the event bus", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    // The observer captures what Layer 1 (logPlugin/envPlugin) put on its ctx at onInit,
    // and hooks the global native:phase event through the framework bus.
    let observedContext:
      | {
          logCalled: boolean;
          envHasUndeclared: boolean;
          envGetUndeclared: string | undefined;
        }
      | undefined;
    const observedPhases: NativePhaseEvent[] = [];
    const observer = createPlugin("observer", {
      onInit: ctx => {
        // Exercise the log seam for real (debug stays below the default sink level).
        ctx.log.debug("observer:init", { composed: true });

        observedContext = {
          logCalled: true,
          // This framework declares no env schema, so the resolved-env contract is
          // "empty but functioning": has() answers false, get() answers undefined.
          envHasUndeclared: ctx.env.has("OBSERVER_NOT_DECLARED"),
          envGetUndeclared: ctx.env.get("OBSERVER_NOT_DECLARED")
        };
      },
      hooks: () => ({
        "native:phase": (payload: NativePhaseEvent) => {
          observedPhases.push(payload);
        }
      })
    });

    const app = createApp({
      plugins: [observer],
      config: { ...VALID_APP_CONFIG, projectDir, outDir, targets: ["macos"] },
      pluginConfigs: {
        tauri: { spawnImpl: spawnBuildSucceeds, nodePath: "/usr/bin/node" },
        // Sink the cli plugin's event-driven rendering so build.run stays terminal-quiet.
        cli: {
          renderImpl: () => {
            /* rendering is not under test in S04 */
          }
        }
      }
    });

    // (1) ctx.log/ctx.env were live and functioning on the consumer plugin's ctx at
    // composition time (registered by logPlugin/envPlugin in Layer 1).
    expect(observedContext).toEqual({
      logCalled: true,
      envHasUndeclared: false,
      envGetUndeclared: undefined
    });

    // (2) Its hook observes the full real phase stream of a build run.
    await seedDmgFixture(projectDir);
    const result = await app.build.run({ target: "macos" });

    expect(result.target).toBe("macos");
    expect(observedPhases.map(event => `${event.phase}:${event.status}`)).toEqual([
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
    expect(observedPhases.every(event => event.target === "macos")).toBe(true);
  });
});

describe("S20 — env core plugin providers + host-derived default targets", () => {
  it("resolves PATH through ctx.env and defaults targets to the host's own", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    // A consumer plugin captures what the kernel handed it at onInit: the resolved
    // env accessor (B1 — the framework seeds a process-env provider in coreConfig)
    // and the global config the framework defaults produced.
    let observed: { path: string | undefined; targets: readonly Target[] } | undefined;
    const observer = createPlugin("env-observer", {
      onInit: ctx => {
        observed = { path: ctx.env.get("PATH"), targets: ctx.global.targets };
      }
    });

    // No `targets` override — this scenario is about what the DEFAULTS produce.
    const app = createApp({
      plugins: [observer],
      config: { ...VALID_APP_CONFIG, projectDir, outDir }
    });

    // (1) env resolves real host variables. With zero providers every get() answered
    // undefined, which left the tauri plugin's PATH-walk node resolution nothing to walk.
    expect(app.env.get("PATH")).toBeTypeOf("string");
    expect(app.env.get("PATH")).not.toBe("");
    expect(observed?.path).toBe(app.env.get("PATH"));

    // (2) targets default to the host's own packaging target — never all five, and
    // mobile is opt-in (it needs an SDK the host may not have).
    expect(observed?.targets).toEqual(hostTargets(process.platform));
    expect(observed?.targets).not.toContain("ios");
    expect(observed?.targets).not.toContain("android");
  });
});
