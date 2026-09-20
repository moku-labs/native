/**
 * @file Smoke — real-toolchain proof (A13). Drives the SHIPPED framework against the real
 * `@tauri-apps/cli`: real `node`, real cargo compile, real Xcode. Opt-in only
 * (`bun run test:smoke`); `bun run test` never includes this project.
 *
 * SAFETY. Every path this file touches lives inside ONE
 * `mkdtemp(tmpdir()/moku-native-smoke-…)` workspace: the fake consumer web app,
 * `projectDir` and `outDir` are all absolute paths below it. `process.chdir` is never
 * called — the run is driven entirely by `web.cwd` plus absolute config paths, which is
 * also what it proves. The single `rm` in this file is guarded by
 * {@link assertSmokeWorkspace}.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Doctor } from "../../src/index";
import { createApp } from "../../src/index";

/** Marker every temp path this file may delete has to carry. */
const SMOKE_PREFIX = "moku-native-smoke-";

/** iOS is buildable on a macOS host only — both cases are skipped elsewhere. */
const IS_MACOS = process.platform === "darwin";

/** The doctor checks that decide whether an iOS simulator build can be attempted at all. */
const IOS_GATE_CHECKS = ["ios-tools", "ios-platform"] as const;

/**
 * Refuses any path that is not one of this file's own temp workspaces. The only
 * destructive call in the smoke suite goes through here first.
 *
 * @param directory - The path about to be removed.
 * @throws {Error} When the path is not a `moku-native-smoke-` directory under the temp root.
 */
function assertSmokeWorkspace(directory: string): void {
  if (!directory.startsWith(tmpdir()) || !directory.includes(SMOKE_PREFIX)) {
    throw new Error(
      `[smoke] Refusing to touch "${directory}".\n  Only a mkdtemp "${SMOKE_PREFIX}" workspace under ${tmpdir()} may be removed.`
    );
  }
}

/**
 * Composes the real app: every seam except the CLI render sink is the production one —
 * real process-group spawn, real PATH-walked `node` (so the env provider is proven too),
 * real doctor probes.
 *
 * @param workspace - The temp workspace acting as the consumer project root.
 * @param rendered - Sink the branded CLI output is collected into instead of the terminal.
 * @returns The composed Layer-3 app.
 */
function composeSmokeApp(workspace: string, rendered: string[]) {
  return createApp({
    config: {
      app: { name: "Moku Smoke", identifier: "com.example.mokusmoke" },
      web: {
        build: "bun run build",
        devCommand: "bun run dev",
        devUrl: "http://localhost:5173",
        dist: "dist",
        // The whole run is anchored here — never on the process cwd.
        cwd: workspace
      },
      system: [],
      capabilities: {},
      targets: ["macos", "ios"],
      projectDir: path.join(workspace, ".moku", "tauri"),
      outDir: path.join(workspace, "dist-native")
    },
    pluginConfigs: {
      cli: {
        renderImpl: (line: string) => {
          rendered.push(line);
        }
      }
    }
  });
}

/** Everything the two cases need from the shared workspace. */
type Smoke = {
  app: ReturnType<typeof composeSmokeApp>;
  workspace: string;
  projectDir: string;
  outDir: string;
  rendered: string[];
};

let smoke: Smoke | undefined;

/**
 * Returns the workspace built in `beforeAll`, failing loudly instead of letting a case
 * run against undefined paths.
 *
 * @returns The shared smoke workspace.
 */
function requireSmoke(): Smoke {
  if (!smoke) throw new Error("[smoke] Workspace missing — beforeAll did not complete.");
  return smoke;
}

/**
 * Collects the human-readable reasons an iOS simulator build cannot be attempted on this
 * host, straight from the real doctor report.
 *
 * @param report - The `doctor.run({ target: "ios" })` report.
 * @returns One line per gate check that is missing or not passing; empty when ready.
 */
function iosGateFailures(report: Doctor.DoctorReport): readonly string[] {
  const failures: string[] = [];
  for (const id of IOS_GATE_CHECKS) {
    const check = report.checks.find(row => row.id === id);
    if (!check) {
      failures.push(`${id}: check did not run`);
      continue;
    }
    if (check.status !== "pass") failures.push(`${id} ${check.status}: ${check.message}`);
  }
  return failures;
}

/**
 * Finds the single `.app` bundle directory a build delivered into `outDir/<target>/`.
 *
 * @param deliveryDirectory - The per-target delivery directory.
 * @returns The absolute path of the `.app` bundle.
 */
async function findAppBundle(deliveryDirectory: string): Promise<string> {
  const entries = await readdir(deliveryDirectory);
  const bundle = entries.find(entry => entry.endsWith(".app"));
  expect(
    bundle,
    `no *.app in ${deliveryDirectory} (found: ${entries.join(", ") || "nothing"})`
  ).toBeDefined();
  return path.join(deliveryDirectory, bundle ?? "");
}

beforeAll(async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), SMOKE_PREFIX));
  assertSmokeWorkspace(workspace);

  // A minimal consumer web app: the two scripts tauri shells out to, plus a built dist/.
  const manifest = {
    name: "moku-native-smoke-app",
    version: "0.0.0",
    private: true,
    scripts: { build: "echo web-built", dev: "echo dev" }
  };
  await writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    "utf8"
  );
  await mkdir(path.join(workspace, "dist"), { recursive: true });
  await writeFile(
    path.join(workspace, "dist", "index.html"),
    '<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>Moku Smoke</title></head>\n  <body><h1>Moku Smoke</h1></body>\n</html>\n',
    "utf8"
  );

  const rendered: string[] = [];
  const app = composeSmokeApp(workspace, rendered);
  await app.start();

  smoke = {
    app,
    workspace,
    projectDir: path.join(workspace, ".moku", "tauri"),
    outDir: path.join(workspace, "dist-native"),
    rendered
  };
});

afterAll(async () => {
  if (!smoke) return;
  await smoke.app.stop();

  // The one destructive call in this suite, on its own mkdtemp workspace only.
  assertSmokeWorkspace(smoke.workspace);
  await rm(smoke.workspace, { recursive: true, force: true });
  smoke = undefined;
});

describe("real toolchain — macOS desktop", () => {
  it("builds a cold generated project into a .app under outDir/macos", async ctx => {
    ctx.skip(!IS_MACOS, "a macOS installer can only be packaged on a macOS host");
    const { app, outDir } = requireSmoke();

    await app.cli.build({ target: "macos" });

    const bundle = await findAppBundle(path.join(outDir, "macos"));
    const bundleStats = await stat(bundle);
    expect(bundleStats.isDirectory()).toBe(true);
  });
});

describe("real toolchain — iOS simulator", () => {
  it("builds an unsigned simulator .app and runs the patched Xcode runner", async ctx => {
    ctx.skip(!IS_MACOS, "an iOS build can only run on a macOS host");
    const { app, outDir, projectDir } = requireSmoke();

    // The real doctor decides: no hand-maintained toolchain probe lives in this file.
    const failures = iosGateFailures(await app.doctor.run({ target: "ios" }));
    ctx.skip(failures.length > 0, `iOS toolchain not ready — ${failures.join(" | ")}`);

    await app.cli.build({ target: "ios", simulator: true });

    const bundle = await findAppBundle(path.join(outDir, "ios"));
    const bundleStats = await stat(bundle);
    expect(bundleStats.isDirectory()).toBe(true);

    // The build only got this far because the baked-in `<runner> tauri ios xcode-script`
    // build phase was rewritten to the absolute pair this framework spawns with (B10).
    const runner = app.tauri.getRunner();
    const projectYml = await readFile(
      path.join(projectDir, "src-tauri", "gen", "apple", "project.yml"),
      "utf8"
    );
    expect(projectYml).toContain(`"${runner.nodePath}" "${runner.tauriJsPath}" ios xcode-script`);
    expect(projectYml).not.toContain("bun tauri");
    expect(projectYml).not.toContain("node tauri");
  });
});
