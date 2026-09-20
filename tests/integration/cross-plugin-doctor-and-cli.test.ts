/**
 * @file Root integration tests — scenarios S08–S12 of the integration test plan
 * (`.planning/build/integration-test-plan.md`): doctor diagnosing over project + tauri
 * (S08), doctor warn-only semantics + registry/env consumption (S09), cli.build rendering
 * live build emissions incl. `{ all: true }` → runAll (S10), cli.doctor rendering
 * per-check rows + summary (S11), and cli.dev driving tauri.dev without owning teardown
 * (S12). Everything runs through the shipped package entry via the shared
 * `createTestApp` helper — real factory chain, injected seams only.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Doctor } from "../../src/index";
import { PHASE_ORDER } from "../../src/index";
import type { RecordedEvent, TestApp, TestAppOptions } from "./helpers/create-test-app";
import { createTestApp } from "./helpers/create-test-app";
import { probeFailFor, spawnDevExitsZero } from "./helpers/fixtures";

/** Test apps created in the running test — all cleaned up in afterEach. */
const testApps: TestApp[] = [];

/** Extra fixture temp dirs created in the running test — all removed in afterEach. */
const extraDirs: string[] = [];

/**
 * Creates a test app through the shared helper and registers it for afterEach cleanup.
 *
 * @param opts - Options forwarded to {@link createTestApp}.
 * @returns The composed test app.
 * @example
 * ```ts
 * const testApp = await newTestApp();
 * ```
 */
async function newTestApp(opts?: TestAppOptions): Promise<TestApp> {
  const testApp = await createTestApp(opts);
  testApps.push(testApp);
  return testApp;
}

/**
 * Creates a fresh fixture temp dir (registered for afterEach removal).
 *
 * @returns The absolute fixture dir path.
 * @example
 * ```ts
 * const fixtureDir = await newFixtureDir();
 * ```
 */
async function newFixtureDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "moku-native-root-fixture-"));
  extraDirs.push(dir);
  return dir;
}

/**
 * Narrows the recorded event stream to the `doctor:check` entries, in emission order.
 *
 * @param events - The recorder plugin's emission-order sink.
 * @returns Only the `doctor:check` events.
 * @example
 * ```ts
 * const checks = doctorCheckEvents(testApp.events);
 * ```
 */
function doctorCheckEvents(
  events: readonly RecordedEvent[]
): Array<Extract<RecordedEvent, { name: "doctor:check" }>> {
  return events.filter(
    (event): event is Extract<RecordedEvent, { name: "doctor:check" }> =>
      event.name === "doctor:check"
  );
}

/**
 * Finds one check result by id in a doctor report, asserting it exists.
 *
 * @param report - The aggregated doctor report.
 * @param id - The check id to find.
 * @returns The matching check result.
 * @example
 * ```ts
 * const check = findCheck(report, "tauri-cli");
 * ```
 */
function findCheck(report: Doctor.DoctorReport, id: string): Doctor.CheckResult {
  const check = report.checks.find(candidate => candidate.id === id);
  expect(check, `expected report to contain check "${id}"`).toBeDefined();
  if (!check) throw new Error(`missing check "${id}"`);
  return check;
}

/**
 * Sorts check results by id+target — `doctor:check` fires per check AS IT SETTLES (A4/M7),
 * so event order is settle order while `report.checks` keeps registry order.
 *
 * @param checks - The check results to sort.
 * @returns A new, id-sorted array.
 * @example
 * ```ts
 * expect(sortChecksById(emitted)).toEqual(sortChecksById(report.checks));
 * ```
 */
function sortChecksById(checks: readonly Doctor.CheckResult[]): Doctor.CheckResult[] {
  return checks.toSorted((a, b) => `${a.id}${a.target}`.localeCompare(`${b.id}${b.target}`));
}

/**
 * Counts non-overlapping occurrences of `needle` in `haystack`.
 *
 * @param haystack - The text to search.
 * @param needle - The substring to count.
 * @returns The occurrence count.
 * @example
 * ```ts
 * countOccurrences("a b a", "a"); // 2
 * ```
 */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Writes a `package.json` fixture into `dir` for the web-script/versions checks.
 *
 * @param dir - The directory to write into (created if needed).
 * @param dependencies - Optional dependencies map (drives the versions-skew check).
 * @example
 * ```ts
 * await writePackageJsonFixture(fixtureDir, { "@tauri-apps/plugin-store": "^1.0.0" });
 * ```
 */
async function writePackageJsonFixture(
  dir: string,
  dependencies?: Record<string, string>
): Promise<void> {
  await mkdir(dir, { recursive: true });

  const pkg = {
    name: "fixture-consumer",
    scripts: { build: "echo build", dev: "echo dev" },
    ...(dependencies ? { dependencies } : {})
  };
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, undefined, 2), "utf8");
}

/** A probe fake whose rustup answer carries the macos, ios (device + sim), AND android triples. */
const probeOkAllTriples: Doctor.ProbeFn = async cmd => ({
  code: 0,
  stdout:
    cmd === "rustup"
      ? "aarch64-apple-darwin\naarch64-apple-ios\naarch64-apple-ios-sim\naarch64-linux-android"
      : "ok"
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();

  await Promise.all(testApps.map(testApp => testApp.cleanup()));
  testApps.length = 0;

  await Promise.all(extraDirs.map(dir => rm(dir, { recursive: true, force: true })));
  extraDirs.length = 0;
});

describe("S08 — doctor.run diagnoses over project + tauri", () => {
  it("emits one doctor:check per report entry, routes tauri-cli through the spawn seam, and consults project completeness", async () => {
    // ios (not android) as the mobile target: the android-toolchain check needs env vars,
    // and the composed env table is frozen EMPTY (envPlugin has no providers configured),
    // so an android scope could never reach ok: true through the shipped composition.
    // The host-scoped web-script/versions checks resolve <web.cwd>/package.json (M6), so the
    // fixture root is pinned there instead of leaking to the repo's own package.json.
    const fixtureDir = await newFixtureDir();
    await writePackageJsonFixture(fixtureDir);

    const testApp = await newTestApp({
      config: {
        targets: ["macos", "ios"],
        web: {
          build: "bun run build",
          devCommand: "bun run dev",
          devUrl: "http://localhost:5173",
          dist: "dist",
          cwd: fixtureDir
        }
      },
      probeImpl: probeOkAllTriples
    });

    // No target → scopes are every configured target PLUS "host" (where tauri-cli lives).
    const report = await testApp.app.doctor.run();

    expect(report.checks.filter(check => check.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);

    // Exactly one doctor:check event per report entry. Emission is per check AS IT SETTLES
    // (A4/M7), so the event order is settle order while report.checks keeps registry order —
    // the two are compared as sets of the same size.
    const checkEvents = doctorCheckEvents(testApp.events);
    expect(checkEvents).toHaveLength(report.checks.length);
    expect(sortChecksById(checkEvents.map(event => event.payload))).toEqual(
      sortChecksById(report.checks)
    );

    // tauri-cli is routed through tauri.version() — the SPAWN seam, not probeImpl:
    // the fake spawn's stdout ("built") becomes the detected CLI version.
    const tauriCli = findCheck(report, "tauri-cli");
    expect(tauriCli.status).toBe("pass");
    expect(tauriCli.message).toContain("built");
    expect(testApp.spawnCalls.some(call => call.argv.includes("info"))).toBe(true);

    // The completeness-category check consulted project state (empty gen/ → not initialized).
    const completeness = findCheck(report, "gen-completeness-ios");
    expect(completeness.status).toBe("pass");
    expect(completeness.message).toContain("not initialized");

    // The same spawn fake answers tauri.version() directly.
    await expect(testApp.app.tauri.getVersion()).resolves.toEqual({ cliVersion: "built" });
  });
});

describe("S09 — doctor warn-only semantics + registry/env consumption", () => {
  it("reports version-skew and cross-repo pointers as warn without flipping report.ok", async () => {
    // One fixture package.json serves BOTH host checks: web-script (via web.cwd) and
    // versions (via a process.cwd() stub) — declaring a major-skewed registry package.
    const fixtureDir = await newFixtureDir();
    await writePackageJsonFixture(fixtureDir, { "@tauri-apps/plugin-store": "^1.0.0" });
    vi.spyOn(process, "cwd").mockReturnValue(fixtureDir);

    const testApp = await newTestApp({
      config: {
        web: {
          build: "bun run build",
          devCommand: "bun run dev",
          devUrl: "http://localhost:5173",
          dist: "dist",
          cwd: fixtureDir
        }
      }
    });

    const report = await testApp.app.doctor.run();

    // Warns never flip ok — every non-pass result below is a warn, and ok stays true.
    expect(report.checks.filter(check => check.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.some(check => check.status === "warn")).toBe(true);

    // Version skew: the declared ^1 npm package vs the registry-pinned ^2 crate range —
    // the message references the registry row (project→doctor data dependency).
    const versions = findCheck(report, "tauri-version-skew");
    expect(versions.status).toBe("warn");
    expect(versions.message).toContain("@tauri-apps/plugin-store@^1.0.0");
    expect(versions.message).toContain("tauri-plugin-store^2");

    // The cross-repo pointer always fires as warn with the packaged-app origin.
    const crossRepo = findCheck(report, "cross-repo-cors");
    expect(crossRepo.status).toBe("warn");
    expect(crossRepo.message).toContain("tauri://localhost");

    // The registry the versions check consumed — 5 pinned rows.
    expect(testApp.app.project.getRegistryRows()).toHaveLength(5);
  });

  it("reports signing env-var PRESENCE by name only — never a value", async () => {
    // A sentinel VALUE placed in the process env must never surface in any message
    // (the composed env table only ever answers has(), and it is frozen at createApp).
    const sentinelValue = ["sentinel", "canary", "value"].join("-");
    vi.stubEnv("MOKU_TEST_SENTINEL_CANARY", sentinelValue);

    const testApp = await newTestApp({
      config: {
        targets: ["android"],
        // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- config-safe env var NAME, not a secret value (SigningConfig invariant).
        signing: { android: { keystorePasswordEnv: "MOKU_TEST_UNSET_KEYSTORE_ENV" } }
      },
      probeImpl: probeOkAllTriples
    });

    // android scope only — the android-toolchain check legitimately fails here (the
    // frozen-empty env has no ANDROID_HOME), so ok is NOT asserted in this half.
    const report = await testApp.app.doctor.run({ target: "android" });

    // Signing names the env var, stays warn (unsigned dev builds are legal), and its
    // fix-it tells the user to export it — presence semantics, not value semantics.
    const signing = findCheck(report, "signing-android");
    expect(signing.status).toBe("warn");
    expect(signing.message).toContain("MOKU_TEST_UNSET_KEYSTORE_ENV");
    expect(signing.fixIt).toContain("MOKU_TEST_UNSET_KEYSTORE_ENV");

    // No env VALUE ever appears in any check message or fix-it.
    const allText = report.checks.map(check => `${check.message} ${check.fixIt ?? ""}`).join("\n");
    expect(allText).not.toContain(sentinelValue);
  });
});

describe("S10 — cli.build renders live progress from real build emissions", () => {
  it("renders every phase in PHASE_ORDER order plus a completion box, and { all: true } completes via runAll", async () => {
    const testApp = await newTestApp();
    await testApp.seedMacosArtifact();

    await testApp.app.cli.build({ target: "macos" });

    // Every pipeline phase name appears, in PHASE_ORDER order (index-sorted assertion).
    const text = testApp.rendered.join("\n");
    const phaseIndices = PHASE_ORDER.map(phase => text.indexOf(phase));
    expect(phaseIndices.every(index => index >= 0)).toBe(true);
    expect(phaseIndices).toEqual(phaseIndices.toSorted((a, b) => a - b));

    // The native:complete box carries app name, target, and the artifact filename.
    expect(text).toContain("Test App");
    expect(text).toContain("macos");
    expect(text).toContain("App_1.0.0.dmg");
    expect(countOccurrences(text, "build complete")).toBe(1);

    // { all: true } routes through build.runAll (configured targets: ["macos"]) — a
    // second completion box renders from the second real native:complete emission.
    await testApp.seedMacosArtifact();
    await testApp.app.cli.build({ all: true });

    const textAfterAll = testApp.rendered.join("\n");
    expect(countOccurrences(textAfterAll, "build complete")).toBe(2);
    expect(testApp.events.filter(event => event.name === "native:complete")).toHaveLength(2);
  });
});

describe("S11 — cli.doctor renders per-check rows + summary", () => {
  it("returns true with all-ok probes and renders one live row per doctor:check plus a counts summary", async () => {
    const testApp = await newTestApp();

    const ok = await testApp.app.cli.doctor({ target: "macos" });

    expect(ok).toBe(true);

    // Exactly ONE row per doctor:check — live from the hook; the summary repeats no row
    // and prints the counts plus the overall verdict (M7).
    const text = testApp.rendered.join("\n");
    const checkEvents = doctorCheckEvents(testApp.events);
    expect(checkEvents.length).toBeGreaterThan(0);
    for (const event of checkEvents) {
      expect(countOccurrences(text, event.payload.id)).toBe(1);
    }

    const counts = { pass: 0, warn: 0, fail: 0 };
    for (const event of checkEvents) counts[event.payload.status] += 1;

    expect(text).toContain("rustup-targets");
    expect(text).toContain("Doctor summary");
    expect(text).toContain(`pass ${counts.pass} · warn ${counts.warn} · fail ${counts.fail}`);
    expect(text).toContain("All checks passed");
  });

  it("returns false when a probe fails, rendering the failing check's fixIt from doctor's real report", async () => {
    const testApp = await newTestApp({ probeImpl: probeFailFor(["rustup"]) });

    const ok = await testApp.app.cli.doctor({ target: "macos" });

    expect(ok).toBe(false);

    // The boolean and the rendering both flow from doctor's report — the failing
    // rustup check's fixIt text surfaces in the rendered output.
    const text = testApp.rendered.join("\n");
    expect(text).toContain("rustup-targets");
    expect(text).toContain("install rustup: https://rustup.rs");
    expect(text).toContain("One or more checks failed");
  });
});

describe("S12 — cli.dev drives tauri.dev without owning teardown", () => {
  it("cli.dev resolves purely from the dev process exit and forwards scrubbed output lines", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
    const testApp = await newTestApp({ spawnImpl: spawnDevExitsZero });

    await expect(testApp.app.cli.dev()).resolves.toBeUndefined();

    // The dev process's output line was forwarded through the render seam (D-014),
    // and the dev verb actually reached the spawn seam.
    expect(testApp.rendered.join("\n")).toContain("Local:");
    expect(testApp.spawnCalls.some(call => call.argv.includes("dev"))).toBe(true);
  });

  it("tauri.dev's handle resolves ready then exited without anything calling stop (D-002)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
    const testApp = await newTestApp({ spawnImpl: spawnDevExitsZero });

    const handle = await testApp.app.tauri.dev({});
    const stopSpy = vi.spyOn(handle, "stop");

    await handle.ready;
    const exit = await handle.exited;

    // Teardown is owned by the handle itself — nothing (cli included) ever called stop.
    expect(exit.code).toBe(0);
    expect(stopSpy).not.toHaveBeenCalled();
  });
});
