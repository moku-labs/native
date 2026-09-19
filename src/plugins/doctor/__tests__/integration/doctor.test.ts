/* eslint-disable unicorn/no-null -- fixture mirrors tauri.version()'s real `{ cliVersion } | null`
   contract (D-014), exercised here through a fake tauri CLI spawn instead of a fake probe. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { Target } from "../../../../config";
import { coreConfig, createCore } from "../../../../config";
import { projectPlugin } from "../../../project";
import { tauriPlugin } from "../../../tauri";
import type { SpawnFn } from "../../../tauri/types";
import { doctorPlugin } from "../../index";
import type { CheckResult, ProbeFn } from "../../types";

// Complex tier: doctor depends on [project, tauri] (D-007) — the harness composes all three
// so this test never has to reach past the real wiring to exercise doctor's own orchestration.
const framework = createCore(coreConfig, { plugins: [projectPlugin, tauriPlugin, doctorPlugin] });

/** Minimal but project-onInit-valid app config, reused by every createApp() call below. */
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

/** Rust target triples covering every configured target's rustup + ios-tools check. */
const ALL_TRIPLES = [
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-apple-ios",
  "aarch64-apple-ios-sim",
  "aarch64-linux-android"
].join("\n");

/**
 * Asserts the report carries exactly the emitted results. Order is compared id-wise after
 * sorting: `doctor:check` fires per check AS IT SETTLES (A4/M7), so emission order is
 * settle order, while `report.checks` keeps the registry order.
 *
 * @param checks - The report's results, in registry order.
 * @param emitted - The recorded `doctor:check` payloads, in settle order.
 */
function expectSameResults(checks: readonly CheckResult[], emitted: readonly CheckResult[]): void {
  const byId = (results: readonly CheckResult[]) =>
    results.toSorted((a, b) => `${a.id}${a.target}`.localeCompare(`${b.id}${b.target}`));
  expect(emitted).toHaveLength(checks.length);
  expect(byId(emitted)).toEqual(byId(checks));
}

/** A probe fake that succeeds every binary presence/version probe doctor issues. */
const probeAlwaysOk: ProbeFn = async cmd => ({
  code: 0,
  stdout: cmd === "rustup" ? ALL_TRIPLES : "ok"
});

/** A fake tauri CLI spawn: succeeds every verb, mimicking `tauri info` output for version(). */
const spawnTauriInfo: SpawnFn = async () => ({
  code: 0,
  signal: null,
  stdout: "tauri-cli 2.9.1",
  stderr: ""
});

/** A probe fake that fails only the rustup probe (message: "boom") — everything else succeeds. */
const throwingProbe: ProbeFn = async cmd => {
  if (cmd === "rustup") throw new Error("boom");
  return { code: 0, stdout: ALL_TRIPLES };
};

/** Registers a `doctor:check` recording hook via a small consumer-added listener plugin. */
function createListener() {
  const emitted: CheckResult[] = [];
  const plugin = framework.createPlugin("doctor-listener", {
    depends: [doctorPlugin],
    hooks: () => ({
      "doctor:check": (payload: CheckResult) => {
        emitted.push(payload);
      }
    })
  });
  return { plugin, emitted };
}

describe("doctor plugin integration", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-doctor-integration-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  const createTestApp = (opts: { targets?: readonly Target[]; probeImpl?: ProbeFn } = {}) => {
    const listener = createListener();
    const app = framework.createApp({
      plugins: [listener.plugin],
      config: {
        ...validAppConfig,
        projectDir,
        ...(opts.targets ? { targets: opts.targets } : {})
      },
      pluginConfigs: {
        doctor: { probeImpl: opts.probeImpl ?? probeAlwaysOk },
        tauri: { spawnImpl: spawnTauriInfo, nodePath: "/usr/bin/node" }
      }
    });
    return { app, emitted: listener.emitted };
  };

  it("run({ target: 'ios' }) emits one doctor:check per applicable check; report matches emissions", async () => {
    const { app, emitted } = createTestApp();

    const report = await app.doctor.run({ target: "ios" });

    expectSameResults(report.checks, emitted);
    expect(report.checks.length).toBeGreaterThan(0);
    for (const result of report.checks) {
      expect(result.target).toBe("ios");
    }
    const ids = report.checks.map(result => result.id);
    expect(ids).toContain("rustup-targets");
    expect(ids).toContain("signing-ios");
    expect(ids).toContain("gen-completeness-ios");
    if (process.platform === "darwin") {
      expect(ids).toContain("xcode-toolchain");
    }
    // No android/host-only checks leak into a single-target run.
    expect(ids).not.toContain("android-toolchain");
    expect(ids).not.toContain("node-binary");
    // Fresh temp dir → gen/ not initialized yet, which is a pass ("will init on first build"),
    // and every applicable ios check is pass/warn under the always-ok probe fake.
    expect(report.ok).toBe(true);
  });

  it("run() with no target covers every configured target plus host checks once", async () => {
    const { app, emitted } = createTestApp({ targets: ["macos"] });

    const report = await app.doctor.run();

    expectSameResults(report.checks, emitted);
    const targets = new Set(report.checks.map(result => result.target));
    expect(targets.has("macos")).toBe(true);
    expect(targets.has("host")).toBe(true);
    const ids = report.checks.map(result => result.id);
    expect(ids).toContain("node-binary");
    expect(ids).toContain("tauri-cli");
    expect(ids).toContain("cross-repo-cors");
    expect(ids).toContain("rustup-targets");
    expect(ids).toContain("signing-macos");
    // completeness never applies to a desktop-only target set.
    expect(ids.some(id => id.startsWith("gen-completeness"))).toBe(false);
  });

  it("runs every applicable check in parallel — probes start before any of them resolve", async () => {
    const startedCommands: string[] = [];
    const resolvers: Array<() => void> = [];
    const deferredProbe: ProbeFn = cmd => {
      startedCommands.push(cmd);
      return new Promise(resolve => {
        resolvers.push(() => resolve({ code: 0, stdout: ALL_TRIPLES }));
      });
    };

    const { app } = createTestApp({
      targets: ["macos", "windows", "linux"],
      probeImpl: deferredProbe
    });

    const reportPromise = app.doctor.run();
    // Flush a couple of microtask turns to be safe, though every check's own first
    // `await` is the probe call itself, so dispatch already happened synchronously.
    await Promise.resolve();
    await Promise.resolve();

    // node (host) + rustup x3 (macos/windows/linux) were all dispatched before any settled.
    expect(startedCommands.length).toBeGreaterThanOrEqual(4);

    for (const resolve of resolvers) resolve();
    const report = await reportPromise;
    expect(report.checks.length).toBeGreaterThanOrEqual(startedCommands.length);
  });

  it("a rejecting check does not sink the whole report", async () => {
    const { app } = createTestApp({ targets: ["macos"], probeImpl: throwingProbe });

    const report = await app.doctor.run({ target: "macos" });

    expect(report.ok).toBe(false);
    const rustupResult = report.checks.find(result => result.id === "rustup-targets");
    expect(rustupResult?.status).toBe("fail");
    expect(rustupResult?.message).toContain("boom");
    const signingResult = report.checks.find(result => result.id === "signing-macos");
    expect(signingResult?.status).toBe("warn");
  });
});

describe("doctor plugin — type-level", () => {
  it("run() returns a typed DoctorReport", () => {
    const app = framework.createApp({ config: validAppConfig });
    expectTypeOf(app.doctor.run).returns.resolves.toExtend<{
      ok: boolean;
      checks: readonly CheckResult[];
    }>();
  });

  it("rejects an invalid target at compile time (runtime: no checks apply)", async () => {
    const app = framework.createApp({ config: validAppConfig });
    // @ts-expect-error — "amiga" is not a valid Target
    const report = await app.doctor.run({ target: "amiga" });
    expect(report).toEqual({ ok: true, checks: [] });
  });

  it("doctor:check hook payload is typed as CheckResult (cli-side type surface)", () => {
    const typedListener = framework.createPlugin("typed-doctor-listener", {
      depends: [doctorPlugin],
      hooks: () => ({
        "doctor:check": (payload: CheckResult) => {
          expectTypeOf(payload).toEqualTypeOf<CheckResult>();
        }
      })
    });
    expect(typedListener.name).toBe("typed-doctor-listener");
  });
});
