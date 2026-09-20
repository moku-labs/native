/**
 * @file Shared test-app factory for the root integration test wave. Composes the SHIPPED
 * framework instance (package entry `src/index.ts` — never `createCore` re-composition) with
 * every subprocess/probe/render/confirm seam injected, a recorder extension plugin capturing
 * `native:phase`/`native:complete`/`doctor:check` in emission order, and fresh `os.tmpdir()`
 * project/out dirs per call. No vitest imports — scenarios own their spies; all defaults
 * here are plain closures (fixtures.ts).
 */
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  Cli,
  Config,
  Doctor,
  NativeCompleteEvent,
  NativePhaseEvent,
  Tauri
} from "../../../src/index";
import { createApp, createPlugin, doctorPlugin } from "../../../src/index";
// PACKAGE ENTRY — the real framework instance, never createCore re-composition:
import { ICON_SOURCE_STAMP_FILE } from "../../../src/plugins/build/pipeline";
import { probeAlwaysOk, spawnBuildSucceeds } from "./fixtures";

/**
 * The exact valid app-config literal used across the plugin integration tests — the shared
 * baseline every test app merges scenario overrides over.
 *
 * @example
 * ```ts
 * const { app } = await createTestApp({ config: { ...VALID_APP_CONFIG, targets: ["android"] } });
 * ```
 */
export const VALID_APP_CONFIG = {
  app: { name: "Test App", identifier: "com.example.testapp" },
  web: {
    build: "bun run build",
    devCommand: "bun run dev",
    devUrl: "http://localhost:5173",
    dist: "dist"
  },
  system: [],
  capabilities: {}
} satisfies Partial<Config>;

/** One captured framework/plugin event, in emission order. */
export type RecordedEvent =
  | { name: "native:phase"; payload: NativePhaseEvent }
  | { name: "native:complete"; payload: NativeCompleteEvent }
  | { name: "doctor:check"; payload: Doctor.CheckResult };

/** One captured subprocess invocation (argv passed to the spawn seam). */
export type SpawnCall = { argv: readonly string[] };

/** Options for {@link createTestApp} — every field optional, every seam defaulted. */
export type TestAppOptions = {
  /** Deep-merged over VALID_APP_CONFIG + fresh temp projectDir/outDir + targets: ["macos"]. */
  config?: Partial<Config>;
  /** Default: spawnBuildSucceeds. Always wrapped by the SpawnCall recorder. */
  spawnImpl?: Tauri.SpawnFn;
  /** Default: probeAlwaysOk. */
  probeImpl?: Doctor.ProbeFn;
  /** Default: pushes into `rendered`. Pass your own to also observe; helper still records. */
  renderImpl?: (line: string) => void;
  /** Default: async () => true. */
  confirmImpl?: (question: string) => Promise<boolean>;
};

/**
 * Creates the recorder extension plugin — a consumer plugin (package-entry `createPlugin`)
 * that hooks the two global build events plus `doctor:check` (hookable with types via the
 * `depends: [doctorPlugin]` edge — spec/07 §5) and pushes each into `events` in order.
 *
 * @param events - The shared emission-order sink the recorder pushes into.
 * @returns The recorder plugin instance, ready for `createApp({ plugins: [recorder] })`.
 */
function createRecorder(events: RecordedEvent[]) {
  return createPlugin("recorder", {
    depends: [doctorPlugin],
    hooks: () => ({
      "native:phase": (payload: NativePhaseEvent) => {
        events.push({ name: "native:phase", payload });
      },
      "native:complete": (payload: NativeCompleteEvent) => {
        events.push({ name: "native:complete", payload });
      },
      "doctor:check": (payload: Doctor.CheckResult) => {
        events.push({ name: "doctor:check", payload });
      }
    })
  });
}

/**
 * Composes the shipped framework app with the recorder plugin and the four injected seams.
 * Non-generic on purpose: its concrete return type IS the fully typed test-app surface
 * (`ReturnType<typeof composeApp>`), keeping `app.project`/`app.doctor`/… precisely typed
 * for `expectTypeOf` assertions.
 *
 * @param recorder - The recorder plugin from {@link createRecorder}.
 * @param config - The fully merged global config (baseline + temp dirs + scenario overrides).
 * @param seams - The resolved seam implementations (spawn already recorder-wrapped).
 * @param seams.spawnImpl - The tauri subprocess seam.
 * @param seams.probeImpl - The doctor probe seam.
 * @param seams.renderImpl - The cli render sink.
 * @param seams.confirmImpl - The cli confirm seam.
 * @returns The composed Layer-3 app.
 */
function composeApp(
  recorder: ReturnType<typeof createRecorder>,
  config: Partial<Config>,
  seams: {
    spawnImpl: Tauri.SpawnFn;
    probeImpl: Doctor.ProbeFn;
    renderImpl: Cli.RenderFn;
    confirmImpl: Cli.ConfirmFn;
  }
) {
  return createApp({
    plugins: [recorder],
    config,
    pluginConfigs: {
      // nodePath is always injected so PATH-walk resolution never runs in tests.
      tauri: { spawnImpl: seams.spawnImpl, nodePath: "/usr/bin/node" },
      doctor: { probeImpl: seams.probeImpl },
      cli: { renderImpl: seams.renderImpl, confirmImpl: seams.confirmImpl }
    }
  });
}

/**
 * Seeds an icon source (backdated an hour), an already-generated
 * `src-tauri/icons/icon.png`, and the `.source` stamp recording that the set was generated
 * from exactly this source — so the pipeline's icons phase reports "up to date" and never
 * spawns the `icon` verb (the icons freshness rule).
 *
 * @param projectDir - The app's generated-project root.
 * @param iconDir - A temp dir OUTSIDE projectDir, so a full `clean()` cannot remove the source.
 * @returns The absolute path of the seeded icon source (`config.app.icon`).
 */
async function seedUpToDateIcons(projectDir: string, iconDir: string): Promise<string> {
  const iconSource = path.join(iconDir, "app-icon.png");
  await writeFile(iconSource, "icon-source-bytes", "utf8");
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(iconSource, anHourAgo, anHourAgo);

  const generatedIcons = path.join(projectDir, "src-tauri", "icons");
  await mkdir(generatedIcons, { recursive: true });
  await writeFile(path.join(generatedIcons, "icon.png"), "generated-icon-bytes", "utf8");

  const stats = await stat(iconSource);
  await writeFile(
    path.join(generatedIcons, ICON_SOURCE_STAMP_FILE),
    [path.resolve(iconSource), stats.size, stats.mtimeMs].join("\n"),
    "utf8"
  );

  return iconSource;
}

/** Everything a scenario needs: the composed app, its temp dirs, and the recorded seams. */
export type TestApp = {
  /** The composed app (package-entry createApp result) — full typed surface. */
  app: ReturnType<typeof composeApp>;
  projectDir: string;
  outDir: string;
  /** Every line written through the cli render seam, in order. */
  rendered: string[];
  /** Every native:phase / native:complete / doctor:check, in emission order (recorder plugin). */
  events: RecordedEvent[];
  /** Every spawn invocation, in order (wrapping recorder around spawnImpl). */
  spawnCalls: SpawnCall[];
  /** Seeds src-tauri/target/release/bundle/dmg/App_1.0.0.dmg under projectDir; returns its path. */
  seedMacosArtifact(): Promise<string>;
  /** rm -rf both temp dirs. Call in afterEach. */
  cleanup(): Promise<void>;
};

/**
 * Builds a fully seamed test app on fresh `os.tmpdir()` directories.
 *
 * Composition: `{ ...VALID_APP_CONFIG, projectDir, outDir, targets: ["macos"], ...opts.config }`
 * (shallow merge — a scenario overriding `app` or `web` supplies the whole object), plus
 * `pluginConfigs` wiring every seam: tauri spawn (recorder-wrapped, `nodePath` pinned),
 * doctor probe, cli render (recorder-wrapped) and confirm. A recorder plugin rides along
 * via `createApp({ plugins: [recorder] })`, capturing all framework/doctor events in order.
 *
 * @param opts - Optional config overrides and seam implementations (all defaulted).
 * @returns The composed {@link TestApp} — call `cleanup()` in `afterEach`.
 * @example
 * ```ts
 * const testApp = await createTestApp();
 * await testApp.seedMacosArtifact();
 * await testApp.app.build.run({ target: "macos" });
 * expect(testApp.events.some(event => event.name === "native:complete")).toBe(true);
 * await testApp.cleanup();
 * ```
 */
export async function createTestApp(opts?: TestAppOptions): Promise<TestApp> {
  // Fresh temp dirs per call — never the repo cwd.
  const projectDir = await mkdtemp(path.join(tmpdir(), "moku-native-root-project-"));
  const outDir = await mkdtemp(path.join(tmpdir(), "moku-native-root-out-"));
  const iconDir = await mkdtemp(path.join(tmpdir(), "moku-native-root-icon-"));

  // The icons phase is pinned to its "up to date" outcome by default: a
  // backdated `app.icon` source plus an already-generated icon set, so a scenario's
  // spawn assertions only ever see the verbs it is actually about. A scenario that
  // wants real icon generation overrides `config.app` without `icon`.
  const iconSource = await seedUpToDateIcons(projectDir, iconDir);

  // Recording sinks — shared by the wrapped seams and the recorder plugin.
  const rendered: string[] = [];
  const events: RecordedEvent[] = [];
  const spawnCalls: SpawnCall[] = [];

  // Wrap the spawn seam so every subprocess invocation lands in spawnCalls, in order.
  const spawnImpl = opts?.spawnImpl ?? spawnBuildSucceeds;
  const recordingSpawn: Tauri.SpawnFn = spawnOpts => {
    spawnCalls.push({ argv: spawnOpts.cmd });
    return spawnImpl(spawnOpts);
  };

  // Wrap the render seam: the helper ALWAYS records; a caller-supplied sink also observes.
  const recordingRender: Cli.RenderFn = line => {
    rendered.push(line);
    opts?.renderImpl?.(line);
  };

  // Confirm defaults to plain approval — scenarios pass their own spy to gate clean().
  const confirmImpl: Cli.ConfirmFn = opts?.confirmImpl ?? (async () => true);

  // Shallow config merge over the shared baseline + fresh dirs + single-target default.
  const config: Partial<Config> = {
    ...VALID_APP_CONFIG,
    app: { ...VALID_APP_CONFIG.app, icon: iconSource },
    projectDir,
    outDir,
    targets: ["macos"],
    ...opts?.config
  };

  const app = composeApp(createRecorder(events), config, {
    spawnImpl: recordingSpawn,
    probeImpl: opts?.probeImpl ?? probeAlwaysOk,
    renderImpl: recordingRender,
    confirmImpl
  });

  return {
    app,
    projectDir,
    outDir,
    rendered,
    events,
    spawnCalls,

    /**
     * Seeds the macos bundle fixture the collect phase globs for.
     *
     * @returns The absolute path of the seeded `.dmg`.
     */
    async seedMacosArtifact(): Promise<string> {
      const dmgDir = path.join(projectDir, "src-tauri", "target", "release", "bundle", "dmg");
      await mkdir(dmgDir, { recursive: true });

      const artifactPath = path.join(dmgDir, "App_1.0.0.dmg");
      await writeFile(artifactPath, "dmg-bytes", "utf8");
      return artifactPath;
    },

    /** Removes the three temp dirs (recursive, force). Call in afterEach. */
    async cleanup(): Promise<void> {
      await rm(projectDir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
      await rm(iconDir, { recursive: true, force: true });
    }
  };
}
