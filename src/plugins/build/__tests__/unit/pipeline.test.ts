import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config as GlobalConfig, TauriRunner } from "../../../../config";
import { PHASE_ORDER } from "../../../../config";
import { projectPlugin } from "../../../project";
import type { CompletenessResult } from "../../../project/types";
import { tauriPlugin } from "../../../tauri";
import type { BuildOptions, RunResult } from "../../../tauri/types";
import { bundleRoot } from "../../collect";
import {
  runCodegen,
  runCompileAndBundle,
  runIcons,
  runPipeline,
  runPrepare,
  runScaffold
} from "../../pipeline";
import type { BuildContext, BuildDeps } from "../../types";

/** The resolved runner pair the tauri mock hands to `project.patchMobile` (B10). */
const RUNNER: TauriRunner = { nodePath: "/usr/bin/node", tauriJsPath: "/cli/tauri.js" };

/** A successful one-shot verb result. */
const okResult = (): RunResult => ({ code: 0, stdout: "", stderr: "", durationMs: 1 });

/** The pipeline never calls `require` — both deps are resolved once in `createBuildApi`. */
const requireNever: BuildContext["require"] = plugin => {
  throw new Error(`ctx.require(${plugin.name}) is not used by the pipeline`);
};

/** Minimal project-api mock — the four methods the prepare phases call. */
function createProjectMock(iconSource: string) {
  return {
    generate: vi.fn(async () => ({ written: [], unchanged: [], skipped: [] })),
    completeness: vi.fn((): CompletenessResult => ({ status: "complete" })),
    patchMobile: vi.fn(async () => ({ patched: [], unchanged: [] })),
    ensureIconSource: vi.fn(async () => iconSource)
  };
}

/** Minimal tauri-api mock — the four methods the codegen/icons/compile phases call. */
function createTauriMock() {
  return {
    mobileInit: vi.fn(async (): Promise<RunResult> => okResult()),
    icon: vi.fn(async (): Promise<RunResult> => okResult()),
    runner: vi.fn((): TauriRunner => RUNNER),
    build: vi.fn(async (opts: BuildOptions): Promise<RunResult> => {
      opts.onTick?.({ crate: "demo" });
      opts.onOutput?.("Bundling app.dmg");
      return okResult();
    })
  };
}

type ProjectMock = ReturnType<typeof createProjectMock>;
type TauriMock = ReturnType<typeof createTauriMock>;

/** Builds a mock `BuildContext` + `BuildDeps` pair with a spy `emit`. */
function createMocks(overrides?: {
  projectDir?: string;
  outDir?: string;
  iconSource?: string;
  appIcon?: string;
  signing?: GlobalConfig["signing"];
  project?: ProjectMock;
  tauri?: TauriMock;
}): {
  ctx: BuildContext;
  deps: BuildDeps;
  emit: ReturnType<typeof vi.fn>;
  project: ProjectMock;
  tauri: TauriMock;
} {
  const project =
    overrides?.project ?? createProjectMock(overrides?.iconSource ?? "/icons/src.png");
  const tauri = overrides?.tauri ?? createTauriMock();
  const emit = vi.fn();

  const ctx: BuildContext = {
    global: {
      app: {
        name: "Test App",
        identifier: "com.example.testapp",
        ...(overrides?.appIcon === undefined ? {} : { icon: overrides.appIcon })
      },
      web: {
        build: "bun run build",
        devCommand: "bun run dev",
        devUrl: "https://x",
        dist: "dist"
      },
      system: [],
      capabilities: {},
      targets: ["macos"],
      projectDir: overrides?.projectDir ?? "/unused",
      outDir: overrides?.outDir ?? "dist-native",
      signing: overrides?.signing ?? {}
    },
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(() => []),
      expect: vi.fn(),
      addSink: vi.fn(),
      reset: vi.fn(),
      clearSinks: vi.fn()
    },
    // build declares neither config nor state — core hands every plugin the empty objects.
    config: {},
    state: {},
    emit,
    require: requireNever
  };

  return { ctx, deps: { project, tauri }, emit, project, tauri };
}

/** Projects the spy emit's calls into `"phase:status"` keys, in emission order. */
function phaseKeys(emit: ReturnType<typeof vi.fn>): string[] {
  return emit.mock.calls.map(call => {
    const payload = call[1] as { phase: string; status: string };
    return `${payload.phase}:${payload.status}`;
  });
}

describe("runScaffold", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-pipeline-scaffold-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("only ensures projectDir exists — the mobile gate moved into codegen (B6)", async () => {
    const nestedDir = path.join(projectDir, "nested");
    const { ctx, project, tauri } = createMocks({ projectDir: nestedDir });

    await runScaffold(ctx);

    expect(existsSync(nestedDir)).toBe(true);
    expect(project.completeness).not.toHaveBeenCalled();
    expect(tauri.mobileInit).not.toHaveBeenCalled();
  });
});

describe("runCodegen", () => {
  it("desktop: calls project.generate only", async () => {
    const { ctx, deps, project, tauri } = createMocks();

    const result = await runCodegen(ctx, deps, "macos");

    expect(result).toEqual({ mobileInitRan: false });
    expect(project.generate).toHaveBeenCalledExactlyOnceWith({ target: "macos" });
    expect(project.patchMobile).not.toHaveBeenCalled();
    expect(tauri.mobileInit).not.toHaveBeenCalled();
  });

  it("mobile not-initialized: generate runs BEFORE mobileInit, then patchMobile gets the runner", async () => {
    const { ctx, deps, project, tauri } = createMocks();
    project.completeness
      .mockReturnValueOnce({ status: "not-initialized" })
      .mockReturnValueOnce({ status: "complete" });

    const result = await runCodegen(ctx, deps, "ios");

    expect(result).toEqual({ mobileInitRan: true });
    // `tauri ios init --ci` needs tauri.conf.json on disk first (B6): generate strictly first.
    const generateOrder = project.generate.mock.invocationCallOrder[0] ?? 0;
    const initOrder = tauri.mobileInit.mock.invocationCallOrder[0] ?? 0;
    const patchOrder = project.patchMobile.mock.invocationCallOrder[0] ?? 0;
    expect(generateOrder).toBeLessThan(initOrder);
    expect(initOrder).toBeLessThan(patchOrder);
    expect(tauri.mobileInit).toHaveBeenCalledExactlyOnceWith({ target: "ios" });
    expect(project.patchMobile).toHaveBeenCalledExactlyOnceWith({
      target: "ios",
      runner: RUNNER
    });
  });

  it("mobile complete: skips mobileInit but still re-applies the idempotent patch pass", async () => {
    const { ctx, deps, project, tauri } = createMocks();

    const result = await runCodegen(ctx, deps, "android");

    expect(result).toEqual({ mobileInitRan: false });
    expect(tauri.mobileInit).not.toHaveBeenCalled();
    expect(project.patchMobile).toHaveBeenCalledExactlyOnceWith({
      target: "android",
      runner: RUNNER
    });
  });

  it("mobile incomplete: fails with a [native] fix-it, never patching", async () => {
    const { ctx, deps, project, tauri } = createMocks();
    project.completeness.mockReturnValue({ status: "incomplete", missing: ["build.gradle.kts"] });

    await expect(runCodegen(ctx, deps, "android")).rejects.toThrow(
      /^\[native\] android project tree is incomplete\.\n {2}Missing build\.gradle\.kts — run `native doctor`/
    );
    expect(tauri.mobileInit).not.toHaveBeenCalled();
    expect(project.patchMobile).not.toHaveBeenCalled();
  });
});

describe("runIcons", () => {
  let projectDir: string;
  let iconSource: string;

  /** Writes the generated `src-tauri/icons/icon.png`, newer than the source by an hour. */
  async function seedGeneratedIconNewerThanSource(): Promise<void> {
    const iconsDir = path.join(projectDir, "src-tauri", "icons");
    await mkdir(iconsDir, { recursive: true });
    await writeFile(path.join(iconsDir, "icon.png"), "generated", "utf8");
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(iconSource, anHourAgo, anHourAgo);
  }

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-pipeline-icons-"));
    iconSource = path.join(projectDir, "app-icon.png");
    await writeFile(iconSource, "source", "utf8");
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("up to date: generated icon newer than the source and no mobileInit → never spawns", async () => {
    await seedGeneratedIconNewerThanSource();
    const { ctx, deps, tauri } = createMocks({ projectDir, iconSource, appIcon: iconSource });

    await expect(runIcons(ctx, deps, { mobileInitRan: false })).resolves.toEqual({
      detail: "up to date"
    });
    expect(tauri.icon).not.toHaveBeenCalled();
  });

  it("generated: a configured app.icon with no generated set yet regenerates from the source", async () => {
    const { ctx, deps, tauri, project } = createMocks({
      projectDir,
      iconSource,
      appIcon: iconSource
    });

    await expect(runIcons(ctx, deps, { mobileInitRan: false })).resolves.toEqual({
      detail: "generated"
    });
    expect(project.ensureIconSource).toHaveBeenCalledOnce();
    expect(tauri.icon).toHaveBeenCalledExactlyOnceWith({ source: iconSource });
  });

  it("placeholder: no app.icon configured → the generated placeholder source is reported", async () => {
    const { ctx, deps, tauri } = createMocks({ projectDir, iconSource });

    await expect(runIcons(ctx, deps, { mobileInitRan: false })).resolves.toEqual({
      detail: "placeholder"
    });
    expect(tauri.icon).toHaveBeenCalledExactlyOnceWith({ source: iconSource });
  });

  it("mobileInit in this pass always regenerates, even with an up-to-date icon set", async () => {
    await seedGeneratedIconNewerThanSource();
    const { ctx, deps, tauri } = createMocks({ projectDir, iconSource, appIcon: iconSource });

    await expect(runIcons(ctx, deps, { mobileInitRan: true })).resolves.toEqual({
      detail: "generated"
    });
    expect(tauri.icon).toHaveBeenCalledExactlyOnceWith({ source: iconSource });
  });
});

describe("runCompileAndBundle", () => {
  it("emits compile done + bundle start LIVE, at the transition line (N1)", async () => {
    const tauri = createTauriMock();
    let keysAtTransition: string[] = [];
    const { ctx, deps, emit } = createMocks({ tauri });
    tauri.build.mockImplementation(async opts => {
      opts.onTick?.({ crate: "demo", index: 1, total: 2 });
      opts.onOutput?.("Bundling application (App.dmg)");
      keysAtTransition = phaseKeys(emit);
      return okResult();
    });

    const result = await runCompileAndBundle(ctx, deps, { target: "macos" });

    // The transition events were already emitted while the subprocess was still running.
    expect(keysAtTransition).toEqual([
      "compile:start",
      "compile:progress",
      "compile:done",
      "bundle:start"
    ]);
    expect(phaseKeys(emit)).toEqual([
      "compile:start",
      "compile:progress",
      "compile:done",
      "bundle:start",
      "bundle:done"
    ]);
    expect(result.compileDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.bundleDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("no transition line: compile done, bundle start and a zero-duration bundle done after exit", async () => {
    const tauri = createTauriMock();
    tauri.build.mockImplementation(async opts => {
      opts.onTick?.({ crate: "demo" });
      return okResult();
    });
    const { ctx, deps, emit } = createMocks({ tauri });

    const result = await runCompileAndBundle(ctx, deps, { target: "macos" });

    expect(phaseKeys(emit)).toEqual([
      "compile:start",
      "compile:progress",
      "compile:done",
      "bundle:start",
      "bundle:done"
    ]);
    expect(emit).toHaveBeenCalledWith("native:phase", {
      target: "macos",
      phase: "compile",
      status: "progress",
      detail: "Compiling demo"
    });
    expect(result.bundleDurationMs).toBe(0);
  });

  it("a failure before the transition is reported on compile", async () => {
    const tauri = createTauriMock();
    tauri.build.mockRejectedValue(new Error("[native] tauri compile failed"));
    const { ctx, deps, emit } = createMocks({ tauri });

    await expect(runCompileAndBundle(ctx, deps, { target: "macos" })).rejects.toThrow(
      "[native] tauri compile failed"
    );
    expect(phaseKeys(emit)).toEqual(["compile:start", "compile:error"]);
  });

  it("a failure after the transition is reported on the open bundle phase (A15)", async () => {
    const tauri = createTauriMock();
    tauri.build.mockImplementation(async opts => {
      opts.onOutput?.("Bundling application (App.dmg)");
      throw new Error("[native] tauri bundling failed");
    });
    const { ctx, deps, emit } = createMocks({ tauri });

    await expect(runCompileAndBundle(ctx, deps, { target: "macos" })).rejects.toThrow(
      "[native] tauri bundling failed"
    );
    expect(phaseKeys(emit)).toEqual([
      "compile:start",
      "compile:done",
      "bundle:start",
      "bundle:error"
    ]);
  });

  it("forwards simulator/aab and the configured Apple export method to tauri.build", async () => {
    const { ctx, deps, tauri } = createMocks({
      signing: { apple: { exportMethod: "release-testing" } }
    });

    await runCompileAndBundle(ctx, deps, { target: "ios", simulator: true, aab: false });

    expect(tauri.build).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ios",
        simulator: true,
        aab: false,
        exportMethod: "release-testing"
      })
    );
  });
});

describe("runPrepare", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-pipeline-prepare-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("runs scaffold → codegen → icons only, never the build verb", async () => {
    const { ctx, deps, emit, tauri } = createMocks({ projectDir });

    const phases = await runPrepare(ctx, deps, "macos");

    expect(phases.map(phase => phase.phase)).toEqual(["scaffold", "codegen", "icons"]);
    expect(phaseKeys(emit)).toEqual([
      "scaffold:start",
      "scaffold:done",
      "codegen:start",
      "codegen:done",
      "icons:start",
      "icons:done"
    ]);
    expect(tauri.build).not.toHaveBeenCalled();
  });
});

describe("runPipeline", () => {
  let projectDir: string;
  let outDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-pipeline-full-"));
    outDir = await mkdtemp(path.join(tmpdir(), "moku-native-pipeline-out-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it("runs every phase in PHASE_ORDER, records six timings, and emits native:complete", async () => {
    const dmgDir = path.join(bundleRoot(projectDir, "macos"), "bundle", "dmg");
    await mkdir(dmgDir, { recursive: true });
    await writeFile(path.join(dmgDir, "App.dmg"), "bytes", "utf8");

    const { ctx, deps, emit } = createMocks({ projectDir, outDir });

    const result = await runPipeline(ctx, deps, { target: "macos" });

    expect(result.phases.map(phase => phase.phase)).toEqual([...PHASE_ORDER]);
    for (const phase of result.phases) {
      expect(phase.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.artifacts).toEqual([path.join(outDir, "macos", "App.dmg")]);
    expect(result.outPath).toBe(path.join(outDir, "macos"));
    expect(emit).toHaveBeenCalledWith(
      "native:complete",
      expect.objectContaining({
        target: "macos",
        outPath: result.outPath,
        artifacts: result.artifacts
      })
    );
  });

  it("a simulator run collects the simulator .app instead of a device .ipa (A7)", async () => {
    const simulatorApp = path.join(
      bundleRoot(projectDir, "ios"),
      "gen",
      "apple",
      "build",
      "arm64-sim",
      "Test App.app"
    );
    await mkdir(simulatorApp, { recursive: true });
    await writeFile(path.join(simulatorApp, "Info.plist"), "plist", "utf8");

    const { ctx, deps } = createMocks({ projectDir, outDir });

    const result = await runPipeline(ctx, deps, { target: "ios", simulator: true });

    expect(result.artifacts).toEqual([path.join(outDir, "ios", "Test App.app")]);
    expect(existsSync(path.join(outDir, "ios", "Test App.app", "Info.plist"))).toBe(true);
  });

  it("stops at the first failing phase — later phases never start", async () => {
    const { ctx, deps, project, emit } = createMocks({ projectDir, outDir });
    project.generate.mockRejectedValue(new Error("[native] codegen exploded"));

    await expect(runPipeline(ctx, deps, { target: "macos" })).rejects.toThrow(
      "[native] codegen exploded"
    );
    expect(phaseKeys(emit)).toEqual([
      "scaffold:start",
      "scaffold:done",
      "codegen:start",
      "codegen:error"
    ]);
  });

  it("propagates the mobile completeness fix-it from codegen, before any compile work", async () => {
    const { ctx, deps, project, tauri, emit } = createMocks({ projectDir, outDir });
    project.completeness.mockReturnValue({ status: "incomplete", missing: ["build.gradle.kts"] });

    await expect(runPipeline(ctx, deps, { target: "android" })).rejects.toThrow(
      /project tree is incomplete/
    );

    expect(tauri.build).not.toHaveBeenCalled();
    expect(tauri.icon).not.toHaveBeenCalled();
    expect(phaseKeys(emit)).toEqual([
      "scaffold:start",
      "scaffold:done",
      "codegen:start",
      "codegen:error"
    ]);
  });
});

describe("projectPlugin/tauriPlugin identity", () => {
  it("both plugin instances carry the names createBuildApi resolves them by", () => {
    expect(projectPlugin.name).toBe("project");
    expect(tauriPlugin.name).toBe("tauri");
  });
});
