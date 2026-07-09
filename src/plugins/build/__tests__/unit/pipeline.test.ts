import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHASE_ORDER } from "../../../../config";
import { projectPlugin } from "../../../project";
import { tauriPlugin } from "../../../tauri";
import { bundleRoot } from "../../collect";
import {
  runCodegen,
  runCompileAndBundle,
  runIcons,
  runPipeline,
  runScaffold
} from "../../pipeline";
import type { BuildContext } from "../../types";

/** Minimal project-api mock — only the methods the scaffold/codegen phases call. */
function createProjectMock() {
  return {
    generate: vi.fn().mockResolvedValue({ written: [], unchanged: [], skipped: [] }),
    completeness: vi.fn().mockReturnValue({ status: "complete" }),
    patchMobile: vi.fn().mockResolvedValue({ patched: [], unchanged: [] })
  };
}

/** Minimal tauri-api mock — only the methods the scaffold/compile phases call. */
function createTauriMock() {
  return {
    mobileInit: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "", durationMs: 1 }),
    build: vi.fn(
      async (opts: {
        onTick?: (tick: { crate: string }) => void;
        onOutput?: (line: string) => void;
      }) => {
        opts.onTick?.({ crate: "demo" });
        opts.onOutput?.("Bundling app.dmg");
        return { code: 0, stdout: "", stderr: "", durationMs: 1 };
      }
    )
  };
}

type ProjectMock = ReturnType<typeof createProjectMock>;
type TauriMock = ReturnType<typeof createTauriMock>;

/** Builds a mock `BuildContext` with fake `project`/`tauri` require targets and a spy emit. */
function createMockCtx(overrides?: {
  projectDir?: string;
  outDir?: string;
  project?: ProjectMock;
  tauri?: TauriMock;
}): { ctx: BuildContext; emit: ReturnType<typeof vi.fn>; project: ProjectMock; tauri: TauriMock } {
  const project = overrides?.project ?? createProjectMock();
  const tauri = overrides?.tauri ?? createTauriMock();
  const emit = vi.fn();
  const requireFn = vi.fn();
  requireFn.mockImplementation((plugin: { name: string }) =>
    plugin.name === "project" ? project : tauri
  );

  const ctx: BuildContext = {
    global: {
      app: { name: "Test App", identifier: "com.example.testapp" },
      web: {
        build: "bun run build",
        dev: { command: "bun run dev", url: "https://x" },
        dist: "dist"
      },
      system: [],
      capabilities: {},
      targets: ["macos"],
      projectDir: overrides?.projectDir ?? "/unused",
      outDir: overrides?.outDir ?? "dist-native",
      signing: {}
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
    emit,
    require: requireFn
  };

  return { ctx, emit, project, tauri };
}

describe("runScaffold", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-pipeline-scaffold-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("desktop: only ensures projectDir exists, never touches project/tauri", async () => {
    const nestedDir = path.join(projectDir, "nested");
    const { ctx, project, tauri } = createMockCtx({ projectDir: nestedDir });

    await runScaffold(ctx, "macos");

    const { existsSync } = await import("node:fs");
    expect(existsSync(nestedDir)).toBe(true);
    expect(project.completeness).not.toHaveBeenCalled();
    expect(tauri.mobileInit).not.toHaveBeenCalled();
  });

  it("mobile not-initialized: initializes once via tauri.mobileInit, then re-checks", async () => {
    const { ctx, project, tauri } = createMockCtx({ projectDir });
    project.completeness
      .mockReturnValueOnce({ status: "not-initialized" })
      .mockReturnValueOnce({ status: "complete" });

    await runScaffold(ctx, "android");

    expect(tauri.mobileInit).toHaveBeenCalledExactlyOnceWith({ platform: "android" });
    expect(project.completeness).toHaveBeenCalledTimes(2);
  });

  it("mobile incomplete: fails fast with a [native] fix-it, never calling mobileInit", async () => {
    const { ctx, project, tauri } = createMockCtx({ projectDir });
    project.completeness.mockReturnValue({ status: "incomplete", missing: ["build.gradle.kts"] });

    await expect(runScaffold(ctx, "android")).rejects.toThrow(
      /^\[native\] android project tree is incomplete\.\n {2}Missing build\.gradle\.kts — run `native doctor`/
    );
    expect(tauri.mobileInit).not.toHaveBeenCalled();
  });

  it("mobile complete: succeeds without calling mobileInit", async () => {
    const { ctx, tauri } = createMockCtx({ projectDir });

    await expect(runScaffold(ctx, "ios")).resolves.toBeUndefined();
    expect(tauri.mobileInit).not.toHaveBeenCalled();
  });
});

describe("runCodegen", () => {
  it("desktop: calls project.generate only", async () => {
    const { ctx, project } = createMockCtx();

    await runCodegen(ctx, "macos");

    expect(project.generate).toHaveBeenCalledExactlyOnceWith({ target: "macos" });
    expect(project.patchMobile).not.toHaveBeenCalled();
  });

  it("mobile: calls project.generate then project.patchMobile", async () => {
    const { ctx, project } = createMockCtx();

    await runCodegen(ctx, "android");

    expect(project.generate).toHaveBeenCalledExactlyOnceWith({ target: "android" });
    expect(project.patchMobile).toHaveBeenCalledExactlyOnceWith({ target: "android" });
  });
});

describe("runIcons", () => {
  it("always reports done/skipped (no icon-source config field exists in v1)", async () => {
    await expect(runIcons()).resolves.toEqual({ detail: "skipped" });
  });
});

describe("runCompileAndBundle", () => {
  it("splits compile/bundle durations at the detected bundling transition line", async () => {
    const { ctx, tauri } = createMockCtx();

    const result = await runCompileAndBundle(ctx, "macos");

    expect(tauri.build).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ target: "macos" })
    );
    expect(result.compileDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.bundleDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits compile progress ticks and a zero-duration bundle fallback when no transition line appears", async () => {
    const tauri = createTauriMock();
    tauri.build.mockImplementation(async opts => {
      opts.onTick?.({ crate: "demo" });
      return { code: 0, stdout: "", stderr: "", durationMs: 1 };
    });
    const { ctx, emit } = createMockCtx({ tauri });

    const result = await runCompileAndBundle(ctx, "macos");

    expect(emit).toHaveBeenCalledWith("native:phase", {
      target: "macos",
      phase: "compile",
      status: "progress",
      detail: "Compiling demo"
    });
    expect(result.bundleDurationMs).toBe(0);
  });

  it("a build failure emits a compile error and never emits a bundle event", async () => {
    const tauri = createTauriMock();
    tauri.build.mockRejectedValue(new Error("[native] tauri compile failed"));
    const { ctx, emit } = createMockCtx({ tauri });

    await expect(runCompileAndBundle(ctx, "macos")).rejects.toThrow(
      "[native] tauri compile failed"
    );

    const phasesSeen = emit.mock.calls.map(call => (call[1] as { phase: string }).phase);
    expect(phasesSeen).toEqual(["compile", "compile"]);
    const statusesSeen = emit.mock.calls.map(call => (call[1] as { status: string }).status);
    expect(statusesSeen).toEqual(["start", "error"]);
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

  it("runs every phase in PHASE_ORDER, records timings, and emits native:complete", async () => {
    const dmgDir = path.join(bundleRoot(projectDir, "macos"), "bundle", "dmg");
    await mkdir(dmgDir, { recursive: true });
    await writeFile(path.join(dmgDir, "App.dmg"), "bytes", "utf8");

    const { ctx, emit } = createMockCtx({ projectDir, outDir });

    const result = await runPipeline(ctx, "macos");

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

  it("stops at the first failing phase — later phases never start", async () => {
    const { ctx, project, emit } = createMockCtx({ projectDir, outDir });
    project.generate.mockRejectedValue(new Error("[native] codegen exploded"));

    await expect(runPipeline(ctx, "macos")).rejects.toThrow("[native] codegen exploded");

    const phasesStarted = emit.mock.calls
      .filter(call => (call[1] as { status: string }).status === "start")
      .map(call => (call[1] as { phase: string }).phase);
    expect(phasesStarted).toEqual(["scaffold", "codegen"]);

    const phasesWithErrors = emit.mock.calls
      .filter(call => (call[1] as { status: string }).status === "error")
      .map(call => (call[1] as { phase: string }).phase);
    expect(phasesWithErrors).toEqual(["codegen"]);
  });

  it("propagates the mobile scaffold fix-it error before any codegen/compile work happens", async () => {
    const { ctx, project, tauri, emit } = createMockCtx({ projectDir, outDir });
    project.completeness.mockReturnValue({ status: "incomplete", missing: ["build.gradle.kts"] });

    await expect(runPipeline(ctx, "android")).rejects.toThrow(/project tree is incomplete/);

    expect(project.generate).not.toHaveBeenCalled();
    expect(tauri.build).not.toHaveBeenCalled();
    const phasesStarted = emit.mock.calls
      .filter(call => (call[1] as { status: string }).status === "start")
      .map(call => (call[1] as { phase: string }).phase);
    expect(phasesStarted).toEqual(["scaffold"]);
  });
});

describe("projectPlugin/tauriPlugin identity used by the require mock", () => {
  it("both plugin instances carry the names the mock dispatcher branches on", () => {
    expect(projectPlugin.name).toBe("project");
    expect(tauriPlugin.name).toBe("tauri");
  });
});
