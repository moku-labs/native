/* eslint-disable unicorn/no-null -- fixtures mirror real Node child_process/SpawnFn result
   shapes (`signal: string | null`, `code: number | null`) per spec/02's Node-mirroring rule. */
/**
 * @file Root integration — edge errors + lifecycle (scenarios S17–S19 of
 * `.planning/build/integration-test-plan.md`):
 *
 * - S17 — invalid config fails loudly (synchronously) at package-entry `createApp` with
 *   `[native]`-formatted actionable errors, through the full five-plugin composition.
 * - S18 — cross-plugin error propagation: a signing-classified TauriError surfaces through
 *   build's `native:phase` error event and cli's renderer; a partial mobile `gen/` tree
 *   fails the scaffold gate BEFORE any subprocess runs.
 * - S19 — lifecycle edges: concurrent dev rejection + idempotent stop + signal-terminated
 *   (code: null) exits treated as clean, doctor's resilience to a REJECTING probe, and
 *   repeated start/stop cycles on one app.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tauri } from "../../src/index";
// PACKAGE ENTRY — the real framework instance, never createCore re-composition:
import { createApp } from "../../src/index";
import type { TestApp, TestAppOptions } from "./helpers/create-test-app";
import { createTestApp, VALID_APP_CONFIG } from "./helpers/create-test-app";
import { probeRejectFor, spawnFailsWith } from "./helpers/fixtures";

/** Deferred cleanups (test apps + directly created temp dirs), drained after every test. */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

/**
 * Builds a helper test app and registers its cleanup with the shared afterEach drain.
 *
 * @param opts - Options forwarded to {@link createTestApp}.
 * @returns The composed test app.
 * @example
 * ```ts
 * const testApp = await makeApp({ probeImpl: probeRejectFor(["rustup"]) });
 * ```
 */
async function makeApp(opts?: TestAppOptions): Promise<TestApp> {
  const testApp = await createTestApp(opts);
  cleanups.push(() => testApp.cleanup());
  return testApp;
}

/**
 * Creates a fresh temp directory pair for a directly constructed (non-helper) app and
 * registers their removal with the shared afterEach drain.
 *
 * @returns The temp projectDir/outDir pair.
 * @example
 * ```ts
 * const { projectDir, outDir } = await makeTempDirs();
 * ```
 */
async function makeTempDirs(): Promise<{ projectDir: string; outDir: string }> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-root-edge-project-"));
  const outDir = await mkdtemp(path.join(tmpdir(), "moku-native-root-edge-out-"));
  cleanups.push(
    () => rm(projectDir, { recursive: true, force: true }),
    () => rm(outDir, { recursive: true, force: true })
  );
  return { projectDir, outDir };
}

// ---------------------------------------------------------------------------
// S17 — Invalid config fails loudly at createApp
// ---------------------------------------------------------------------------

describe("S17 — invalid config fails loudly at createApp", () => {
  it("throws synchronously for an unknown config.system capability, listing every known name", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    // Synchronous throw = composition-time failure (project.onInit), never first-build failure.
    expect(() =>
      createApp({
        config: {
          ...VALID_APP_CONFIG,
          projectDir,
          outDir,
          system: [{ name: "bluetooth" }]
        }
      })
    ).toThrow(
      '[native] Unknown capability "bluetooth" in config.system.\n' +
        "  Known capabilities: store, notification, clipboard-manager, tray, deep-link."
    );
  });

  it("throws synchronously when deep-link is composed without its required scheme", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    expect(() =>
      createApp({
        config: {
          ...VALID_APP_CONFIG,
          projectDir,
          outDir,
          system: [{ name: "deep-link" }],
          capabilities: {}
        }
      })
    ).toThrow(
      '[native] deep-link is composed in config.system but capabilities["deep-link"].scheme is missing.\n' +
        '  Set capabilities["deep-link"] = { mode: "scheme", scheme: "yourscheme" }.'
    );
  });

  it("throws synchronously for an empty web.devUrl with an actionable suggestion", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    // Shallow config merge — an override of `web` supplies the whole object.
    expect(() =>
      createApp({
        config: {
          ...VALID_APP_CONFIG,
          projectDir,
          outDir,
          web: {
            build: "bun run build",
            devCommand: "bun run dev",
            devUrl: "",
            dist: "dist"
          }
        }
      })
    ).toThrow(
      "[native] web.devUrl is required.\n  Set config.web.devUrl to your dev server's URL."
    );
  });

  it("every S17 failure follows the [native] + suggestion-line format", async () => {
    const { projectDir, outDir } = await makeTempDirs();
    const invalidConfigs = [
      { ...VALID_APP_CONFIG, projectDir, outDir, system: [{ name: "bluetooth" }] },
      { ...VALID_APP_CONFIG, projectDir, outDir, system: [{ name: "deep-link" }] },
      {
        ...VALID_APP_CONFIG,
        projectDir,
        outDir,
        web: { build: "bun run build", devCommand: "bun run dev", devUrl: "", dist: "dist" }
      }
    ];

    for (const config of invalidConfigs) {
      let caught: unknown;
      try {
        createApp({ config });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      // First line: [native]-prefixed defect. Second line: indented actionable suggestion.
      expect((caught as Error).message).toMatch(/^\[native\] .+\n {2}\S/);
    }
  });

  it("a control createApp with the valid baseline config does not throw", async () => {
    const { projectDir, outDir } = await makeTempDirs();

    const app = createApp({ config: { ...VALID_APP_CONFIG, projectDir, outDir } });

    // The full five-plugin surface composed — validation passed, verbs are reachable.
    expect(typeof app.project.generate).toBe("function");
    expect(typeof app.cli.build).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// S18 — Error propagation across the plugin chain
// ---------------------------------------------------------------------------

describe("S18 — cross-plugin error propagation", () => {
  it("S18a: a signing failure propagates TauriError → build phase error → cli [native] render", async () => {
    const testApp = await makeApp({
      spawnImpl: spawnFailsWith("error running bundle_dmg: failed to run codesign")
    });

    // cli.build rejects with tauri's classified [native] signing message.
    let caught: unknown;
    try {
      await testApp.app.cli.build({ target: "macos" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "[native] tauri signing failed.\n" +
        "  Check your signing configuration (certificates/keystore/keychain) and run `native doctor`."
    );
    expect(caught).toMatchObject({ name: "TauriError", kind: "signing-failed", exitCode: 1 });

    // The failure was attributed to the compile phase via native:phase (bundle never starts).
    const phaseEvents = testApp.events.filter(event => event.name === "native:phase");
    const compileError = phaseEvents.find(
      event => event.payload.phase === "compile" && event.payload.status === "error"
    );
    expect(compileError?.payload.detail).toContain("[native] tauri signing failed");
    expect(phaseEvents.some(event => event.payload.phase === "bundle")).toBe(false);

    // No completion: the pipeline stopped at the failing phase.
    expect(testApp.events.some(event => event.name === "native:complete")).toBe(false);

    // cli rendered the [native]-formatted failure line from the same event stream.
    expect(testApp.rendered.some(line => line.includes("[native] tauri signing failed"))).toBe(
      true
    );
  });

  it("S18b: a partial gen/android tree fails the codegen gate before any subprocess runs", async () => {
    const testApp = await makeApp();

    // Fabricate a PARTIAL tree: only the FIRST required file, read from the API at runtime.
    const required = testApp.app.project.getRequiredFiles({ target: "android" });
    const firstRequired = required[0];
    expect(firstRequired).toBeDefined();
    if (firstRequired === undefined) throw new Error("requiredFiles(android) is empty");

    const genDir = path.join(testApp.projectDir, "src-tauri", "gen", "android");
    const firstPath = path.join(genDir, firstRequired);
    await mkdir(path.dirname(firstPath), { recursive: true });
    await writeFile(firstPath, "partial", "utf8");

    // The gate rejects with the fix-it pointing at doctor/clean...
    let caught: unknown;
    try {
      await testApp.app.build.run({ target: "android" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/^\[native\] android project tree is incomplete\./);
    expect(message).toContain("run `native doctor` to diagnose");
    expect(message).toContain("`native clean --target android`");

    // ...naming every still-missing required file...
    for (const missing of required.slice(1)) {
      expect(message).toContain(missing);
    }

    // ...and no subprocess EVER ran (no mobileInit re-init of a partial tree — tauri#13902 posture).
    expect(testApp.spawnCalls).toHaveLength(0);

    // The failure surfaced as a codegen-phase error (the gate lives in codegen, since
    // `tauri android init --ci` needs the generated tauri.conf.json); icons never started.
    const phaseEvents = testApp.events.filter(event => event.name === "native:phase");
    expect(
      phaseEvents.some(
        event => event.payload.phase === "codegen" && event.payload.status === "error"
      )
    ).toBe(true);
    expect(phaseEvents.some(event => event.payload.phase === "icons")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S19 — Lifecycle edge cases
// ---------------------------------------------------------------------------

describe("S19 — lifecycle edges", () => {
  it("S19a: rejects a concurrent dev, stops idempotently, and frees the slot after stop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));

    // A deferred dev process: never exits until its abort signal fires (stop() → group-kill).
    const deferredDevSpawn: Tauri.SpawnFn = opts =>
      new Promise(resolve => {
        const finish = (): void =>
          resolve({ code: null, signal: "SIGTERM", stdout: "", stderr: "" });
        if (opts.signal?.aborted) {
          finish();
          return;
        }
        opts.signal?.addEventListener("abort", finish, { once: true });
      });
    const testApp = await makeApp({ spawnImpl: deferredDevSpawn });

    const handle = await testApp.app.tauri.dev({});
    await handle.ready;

    // A second concurrent dev is rejected with the [native] already-running error.
    await expect(testApp.app.tauri.dev({})).rejects.toThrow(
      "[native] tauri dev already running.\n" +
        "  Call stop() on the existing dev handle before starting another."
    );

    // stop() resolves, the exit is signal-terminated (code: null — NOT an error)...
    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(handle.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });

    // ...and a second stop() is idempotent (resolves, no throw).
    await expect(handle.stop()).resolves.toBeUndefined();

    // Let the plugin's exited.finally state-clearing settle, then the slot is free again.
    await new Promise(resolve => setImmediate(resolve));
    const secondHandle = await testApp.app.tauri.dev({});
    await secondHandle.stop();
    await expect(secondHandle.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
  });

  it("S19a: cli.dev treats a signal-terminated exit (code: null) as a clean stop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));

    // The dev process exits via signal immediately — the normal Ctrl-C group-kill shape.
    const testApp = await makeApp({
      spawnImpl: async () => ({ code: null, signal: "SIGTERM", stdout: "", stderr: "" })
    });

    // The recent regression fix: code: null must NOT be classified as a failure.
    await expect(testApp.app.cli.dev()).resolves.toBeUndefined();
  });

  it("S19b: doctor.run survives a REJECTING probe — check-level failure, never a crash", async () => {
    const testApp = await makeApp({ probeImpl: probeRejectFor(["rustup"]) });

    // The rejection never escapes run() — allSettled maps it to an internal-error result.
    const report = await testApp.app.doctor.run({ target: "macos" });

    expect(report.ok).toBe(false);
    const rustup = report.checks.find(check => check.id === "rustup-targets");
    expect(rustup).toBeDefined();
    expect(rustup?.status).toBe("fail");
    expect(rustup?.message).toBe(
      '[native] doctor check "rustup-targets" failed internally: probe rejected: rustup.'
    );

    // The rejection stayed check-local: no other check flipped to fail.
    const failedIds = report.checks.filter(check => check.status === "fail").map(check => check.id);
    expect(failedIds).toEqual(["rustup-targets"]);

    // The doctor:check event still fired for the internally-failed check — one per result.
    const checkEvents = testApp.events.filter(event => event.name === "doctor:check");
    expect(checkEvents.map(event => event.payload.id)).toContain("rustup-targets");
    expect(checkEvents).toHaveLength(report.checks.length);
  });

  it("S19c: start/stop cycles resolve cleanly on fresh apps (core enforces start-once)", async () => {
    // Cycle one fresh app through its full lifecycle.
    const firstApp = await makeApp();
    await expect(firstApp.app.start()).resolves.toBeUndefined();
    await expect(firstApp.app.stop()).resolves.toBeUndefined();

    // Core's lifecycle is start-once: a second start() on the SAME app is rejected loudly
    // (plan deviation — the spec'd "twice over" cycle is only valid across fresh apps).
    await expect(firstApp.app.start()).rejects.toThrow(
      "[native] App already started.\n  start() can only be called once."
    );

    // The composed surface stays functional after stop — no held resources.
    expect(firstApp.app.project.getRegistryRows()).toHaveLength(5);

    // A SECOND fresh app cycles just as cleanly — nothing leaked across app lifecycles.
    const secondApp = await makeApp();
    await expect(secondApp.app.start()).resolves.toBeUndefined();
    await expect(secondApp.app.stop()).resolves.toBeUndefined();
    expect(secondApp.app.project.getRegistryRows()).toHaveLength(5);
  });
});
