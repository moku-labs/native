/**
 * @file Root integration — journey scenarios S13–S16 (consumer workflows): the
 * fresh-machine ship script (S13: start → cli.doctor → cli.build → installer in outDir →
 * stop), incremental rebuild write-if-changed idempotence (S14), the confirm-gated clean
 * lifecycle through the cli (S15), and capability-rich permission-surface codegen
 * including the deep-link scheme (S16). All scenarios run the SHIPPED framework instance
 * via the shared `createTestApp` helper — real factory chain, injected seams only.
 */
import { existsSync } from "node:fs";
import { readFile, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestApp } from "./helpers/create-test-app";
import { createTestApp } from "./helpers/create-test-app";

/** The five system capabilities composed in S16 — every v1 registry row at once. */
const ALL_SYSTEM_CAPABILITIES = [
  { name: "store" },
  { name: "notification" },
  { name: "clipboard-manager" },
  { name: "tray" },
  { name: "deep-link" }
] as const;

describe("journey consumer workflows (S13–S16)", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  describe("S13 — fresh-machine ship journey (start → doctor → build → installer → stop)", () => {
    it("ships a macos installer through the cli surface alone, doctor summary before build box", async () => {
      testApp = await createTestApp();
      const { app, outDir, rendered, events } = testApp;

      // The spec's consumer-script shape: boot the app first.
      await app.start();

      // Diagnose the (fake) fresh machine — every macos-scoped check passes or warns.
      const ok = await app.cli.doctor({ target: "macos" });
      expect(ok).toBe(true);

      // Ship: seed the bundle fixture the collect phase globs for, then build via the cli.
      await testApp.seedMacosArtifact();
      await app.cli.build({ target: "macos" });

      // The installer landed at the stable delivery location, on disk.
      const installerPath = path.join(outDir, "macos", "App_1.0.0.dmg");
      expect(existsSync(installerPath)).toBe(true);
      const installerBytes = await readFile(installerPath, "utf8");
      expect(installerBytes.length).toBeGreaterThan(0);

      await app.stop();

      // Rendered output carries the doctor summary FIRST, then the build completion box.
      const text = rendered.join("\n");
      const summaryIndex = text.indexOf("Doctor summary");
      const completeIndex = text.indexOf("Test App — macos build complete");
      expect(summaryIndex).toBeGreaterThanOrEqual(0);
      expect(completeIndex).toBeGreaterThan(summaryIndex);
      expect(text).toContain("App_1.0.0.dmg");

      // All three event families flowed through the bus: doctor:check rows plus the
      // full successful pipeline (13 native:phase — 6 phases × start/done + one
      // compile progress tick) and exactly one native:complete.
      const checkEvents = events.filter(event => event.name === "doctor:check");
      const phaseEvents = events.filter(event => event.name === "native:phase");
      const completeEvents = events.filter(event => event.name === "native:complete");
      expect(checkEvents.length).toBeGreaterThan(0);
      expect(phaseEvents).toHaveLength(13);
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]?.payload.artifacts).toContain(installerPath);
    });
  });

  describe("S14 — incremental rebuild preserves unchanged artifacts (write-if-changed)", () => {
    it("second build leaves tauri.conf.json untouched while still resolving a full BuildResult", async () => {
      testApp = await createTestApp();
      const { app, projectDir, events } = testApp;
      await testApp.seedMacosArtifact();

      // Run 1 generates the tree from scratch.
      const first = await app.build.run({ target: "macos" });
      expect(first.artifacts.length).toBeGreaterThan(0);

      // Backdate the generated conf's mtime so ANY rewrite in run 2 would be visible
      // regardless of filesystem timer resolution.
      const confPath = path.join(projectDir, "src-tauri", "tauri.conf.json");
      const contentAfterRun1 = await readFile(confPath, "utf8");
      const backdated = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(confPath, backdated, backdated);
      const statAfterBackdate = await stat(confPath);

      // Run 2 — the incremental rebuild (the seeded .dmg is copied, never consumed).
      const second = await app.build.run({ target: "macos" });

      // The Cargo invariant: unchanged content is never rewritten, so the backdated
      // mtime survives and the content is byte-identical.
      const statAfterRun2 = await stat(confPath);
      expect(statAfterRun2.mtimeMs).toBe(statAfterBackdate.mtimeMs);
      expect(await readFile(confPath, "utf8")).toBe(contentAfterRun1);

      // Run 2 still resolved a FULL pipeline result — all six phases, in order.
      expect(second.phases.map(entry => entry.phase)).toEqual([
        "scaffold",
        "codegen",
        "icons",
        "compile",
        "bundle",
        "collect"
      ]);
      expect(events.filter(event => event.name === "native:complete")).toHaveLength(2);

      // Direct project.generate reports everything unchanged (and nothing written).
      const generateResult = await app.project.generate({ target: "macos" });
      expect(generateResult.written).toEqual([]);
      expect(generateResult.unchanged).toContain(confPath);
      expect(generateResult.unchanged.length).toBeGreaterThan(0);
    });
  });

  describe("S15 — clean lifecycle through the cli (target-scoped, confirm-gated full wipe)", () => {
    it("target clean skips confirm, full clean aborts on decline and wipes on approval", async () => {
      let confirmResponse = false;
      const confirmImpl = vi.fn(async () => confirmResponse);
      testApp = await createTestApp({ confirmImpl });
      const { app, projectDir } = testApp;

      // A successful build first, so there is real derived state to clean.
      await testApp.seedMacosArtifact();
      await app.cli.build({ target: "macos" });
      const dmgBundleDir = path.join(projectDir, "src-tauri", "target", "release", "bundle", "dmg");
      const confPath = path.join(projectDir, "src-tauri", "tauri.conf.json");
      expect(existsSync(dmgBundleDir)).toBe(true);
      expect(existsSync(confPath)).toBe(true);

      // Target-scoped clean: removes the macos bundle output WITHOUT any confirm gate,
      // and the generated project tree survives.
      await app.cli.clean({ target: "macos" });
      expect(confirmImpl).not.toHaveBeenCalled();
      expect(existsSync(dmgBundleDir)).toBe(false);
      expect(existsSync(confPath)).toBe(true);
      expect(existsSync(projectDir)).toBe(true);

      // Full clean, declined: confirm is consulted once and NOTHING is deleted.
      await app.cli.clean();
      expect(confirmImpl).toHaveBeenCalledTimes(1);
      expect(confirmImpl).toHaveBeenCalledWith(expect.stringContaining(projectDir));
      expect(existsSync(projectDir)).toBe(true);
      expect(existsSync(confPath)).toBe(true);

      // Full clean, approved: the entire projectDir is wiped.
      confirmResponse = true;
      await app.cli.clean();
      expect(confirmImpl).toHaveBeenCalledTimes(2);
      expect(existsSync(projectDir)).toBe(false);
    });
  });

  describe("S16 — capability-rich app codegen journey (all five system capabilities)", () => {
    it("codegens the full permission surface incl. the deep-link scheme", async () => {
      testApp = await createTestApp({
        config: {
          system: ALL_SYSTEM_CAPABILITIES,
          capabilities: { "deep-link": { mode: "scheme", scheme: "myapp" } }
        }
      });
      const { app, projectDir, events } = testApp;

      await testApp.seedMacosArtifact();
      await app.cli.build({ target: "macos" });
      expect(events.filter(event => event.name === "native:complete")).toHaveLength(1);

      // tauri.conf.json: one plugins.<name> block per composed capability, with the
      // deep-link scheme riding in its conf fragment (D-011).
      const confRaw = await readFile(path.join(projectDir, "src-tauri", "tauri.conf.json"), "utf8");
      const conf = JSON.parse(confRaw) as { plugins: Record<string, { schemes?: string[] }> };
      expect(Object.keys(conf.plugins).toSorted()).toEqual([
        "clipboard-manager",
        "deep-link",
        "notification",
        "store",
        "tray"
      ]);
      expect(conf.plugins["deep-link"]?.schemes).toEqual(["myapp"]);

      // capabilities/default.json: permission ids for all five capabilities — tray's
      // core:tray:default is present because macos is a desktop target.
      const capabilitiesRaw = await readFile(
        path.join(projectDir, "src-tauri", "capabilities", "default.json"),
        "utf8"
      );
      const capabilityDoc = JSON.parse(capabilitiesRaw) as {
        platforms: string[];
        permissions: string[];
      };
      expect(capabilityDoc.platforms).toEqual(["macos"]);
      expect(capabilityDoc.permissions).toEqual(
        expect.arrayContaining([
          "store:default",
          "notification:default",
          "clipboard-manager:allow-read-text",
          "clipboard-manager:allow-write-text",
          "core:tray:default",
          "deep-link:default"
        ])
      );

      // lib.rs / Cargo.toml reference the capability crates. Tray ships as a core Tauri
      // capability (registry rustInit is empty), so exactly FOUR crates appear — the
      // other four rows each contribute a .plugin(...) init line and a pinned dependency.
      const libRs = await readFile(path.join(projectDir, "src-tauri", "src", "lib.rs"), "utf8");
      expect(libRs).toContain(".plugin(tauri_plugin_store::Builder::default().build())");
      expect(libRs).toContain(".plugin(tauri_plugin_notification::init())");
      expect(libRs).toContain(".plugin(tauri_plugin_clipboard_manager::init())");
      expect(libRs).toContain(".plugin(tauri_plugin_deep_link::init())");
      expect(libRs).not.toContain("tray");

      const cargoToml = await readFile(path.join(projectDir, "src-tauri", "Cargo.toml"), "utf8");
      expect(cargoToml).toContain('tauri-plugin-store = "^2"');
      expect(cargoToml).toContain('tauri-plugin-notification = "^2"');
      expect(cargoToml).toContain('tauri-plugin-clipboard-manager = "^2"');
      expect(cargoToml).toContain('tauri-plugin-deep-link = "^2"');
      expect(cargoToml).not.toContain("tauri-plugin-tray");

      // Direct registry surface: typed narrowing guard + resolve carrying the scheme.
      expect(app.project.isKnownCapability("store")).toBe(true);
      expect(app.project.isKnownCapability("nope")).toBe(false);
      const resolved = app.project.resolve("deep-link", { mode: "scheme", scheme: "myapp" });
      expect(resolved.conf).toEqual({ schemes: ["myapp"] });
      expect(resolved.permissions).toContain("deep-link:default");

      // Type-level: a bogus deep-link mode is rejected at compile time (never invoked).
      const rejectsBogusMode = () =>
        // @ts-expect-error — "universal" is not a valid v1 deep-link mode (scheme-only, D-011)
        app.project.resolve("deep-link", { mode: "universal", scheme: "myapp" });
      expect(rejectsBogusMode).toBeTypeOf("function");
    });
  });
});
