import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertCleanableRoot,
  assertWithinRoot,
  clean,
  cleanTargets,
  clearMobileBuildOutput,
  isClearableBuildOutput,
  mobileBuildOutputPath
} from "../../clean";

// ---------------------------------------------------------------------------
// assertCleanableRoot — the FIRST gate. Tested as a pure predicate ONLY: an unsafe
// path is never handed to `clean`, because `clean` would delete it.
// ---------------------------------------------------------------------------

// Every gate below takes its platform explicitly: `assertCleanableRoot` otherwise falls back
// to `process.platform`, and case folding is exactly what differs between the two hosts.
const PLATFORMS = ["darwin", "linux"] as const satisfies readonly NodeJS.Platform[];

const cwd = path.join(path.sep, "repo", "app");
const home = path.join(path.sep, "Users", "alex");

/** Paths no host may ever treat as a cleanable `projectDir`. */
const REFUSED_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["the cwd itself", cwd],
  ["the home directory", home],
  ["a filesystem root", path.parse(cwd).root],
  ["an ancestor of the cwd", path.join(path.sep, "repo")],
  ["a personal directory that is merely outside the cwd", path.join(home, "Documents")],
  ["a sibling sharing a path prefix", path.join(path.sep, "repo", "app-other")],
  ["a directory under the home directory", path.join(home, "work", ".moku", "tauri")]
];

/** Paths every host must accept as derived build output. */
const ALLOWED_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["a dedicated subdirectory of the cwd", path.join(cwd, ".moku", "tauri")],
  ["a workspace under the temp root", path.join(tmpdir(), "moku-native-fixture")]
];

describe.each(PLATFORMS)("assertCleanableRoot on %s", platform => {
  it.each(REFUSED_ROOTS)("refuses %s", (_label, root) => {
    expect(() => assertCleanableRoot(root, cwd, home, platform)).toThrow(
      '[native] Refusing to clean projectDir "'
    );
  });

  it("names the fix in the error's second line", () => {
    expect(() => assertCleanableRoot(cwd, cwd, home, platform)).toThrow(
      'Set config.projectDir to a dedicated subdirectory such as ".moku/tauri".'
    );
  });

  it.each(ALLOWED_ROOTS)("allows %s", (_label, root) => {
    expect(() => assertCleanableRoot(root, cwd, home, platform)).not.toThrow();
  });
});

describe("assertCleanableRoot — case rules and real paths", () => {
  it("compares case-insensitively on darwin and case-sensitively on linux", () => {
    const mixedCase = path.join(path.sep, "repo", "APP", ".moku", "tauri");

    expect(() => assertCleanableRoot(mixedCase, cwd, home, "darwin")).not.toThrow();
    expect(() => assertCleanableRoot(mixedCase, cwd, home, "linux")).toThrow(
      '[native] Refusing to clean projectDir "'
    );
  });

  it("refuses a case-shifted cwd on darwin", () => {
    expect(() =>
      assertCleanableRoot(path.join(path.sep, "REPO", "App"), cwd, home, "darwin")
    ).toThrow('[native] Refusing to clean projectDir "');
  });

  it("resolves symlinks instead of trusting the lexical path", async () => {
    // A real mkdtemp directory is cleanable; a symlink sitting in the SAME directory but
    // pointing at the home directory is not — only a realpath-based guard can tell them apart.
    // The one gate here that takes the REAL host on purpose: the point is that `realpathSync`
    // sees through the link, and the verdict is the same on every host because a temp
    // workspace is always derived state and the home directory never is.
    const dir = await mkdtemp(path.join(tmpdir(), "moku-native-guard-"));
    const link = path.join(dir, "home-link");
    await symlink(homedir(), link, "dir");

    try {
      expect(() => assertCleanableRoot(dir)).not.toThrow();
      expect(() => assertCleanableRoot(link)).toThrow('[native] Refusing to clean projectDir "');
    } finally {
      // Explicit unlink + rmdir: the symlink is removed, never followed.
      await unlink(link);
      await rmdir(dir);
    }
  });
});

describe("cleanTargets", () => {
  it("scopes to the whole projectDir when target is omitted", () => {
    expect(cleanTargets("/repo/.moku/tauri")).toEqual([path.resolve("/repo/.moku/tauri")]);
  });

  it("scopes mobile targets to gen/<platform> only", () => {
    expect(cleanTargets("/repo/.moku/tauri", "android")).toEqual([
      path.resolve("/repo/.moku/tauri/src-tauri/gen/android")
    ]);
    expect(cleanTargets("/repo/.moku/tauri", "ios")).toEqual([
      path.resolve("/repo/.moku/tauri/src-tauri/gen/apple")
    ]);
  });

  it("scopes desktop targets to Tauri's format-named bundle directories", () => {
    const bundle = "/repo/.moku/tauri/src-tauri/target/release/bundle";
    expect(cleanTargets("/repo/.moku/tauri", "macos")).toEqual([
      path.resolve(bundle, "dmg"),
      path.resolve(bundle, "macos")
    ]);
    expect(cleanTargets("/repo/.moku/tauri", "windows")).toEqual([
      path.resolve(bundle, "nsis"),
      path.resolve(bundle, "msi")
    ]);
    expect(cleanTargets("/repo/.moku/tauri", "linux")).toEqual([
      path.resolve(bundle, "appimage"),
      path.resolve(bundle, "deb"),
      path.resolve(bundle, "rpm")
    ]);
  });
});

describe("assertWithinRoot", () => {
  it("allows the root itself", () => {
    expect(() => assertWithinRoot("/repo/.moku/tauri", "/repo/.moku/tauri")).not.toThrow();
  });

  it("allows a nested path", () => {
    expect(() =>
      assertWithinRoot("/repo/.moku/tauri", "/repo/.moku/tauri/src-tauri/gen/android")
    ).not.toThrow();
  });

  it("refuses a path outside the root", () => {
    expect(() => assertWithinRoot("/repo/.moku/tauri", "/etc/passwd")).toThrow(
      "[native] Refusing to clean path outside projectDir"
    );
  });

  it("refuses a sibling path with a shared prefix", () => {
    expect(() => assertWithinRoot("/repo/.moku/tauri", "/repo/.moku/tauri-evil")).toThrow(
      "[native] Refusing to clean path outside projectDir"
    );
  });
});

describe("clean", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-clean-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes gen/<platform> for a mobile target", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "android");
    await mkdir(genDir, { recursive: true });
    await writeFile(path.join(genDir, "marker"), "x", "utf8");

    const result = await clean(dir, "android");

    expect(existsSync(genDir)).toBe(false);
    expect(result.removed).toEqual([path.resolve(genDir)]);
  });

  it("reports nothing removed when the target path does not exist", async () => {
    const result = await clean(dir, "android");
    expect(result.removed).toEqual([]);
  });

  it("removes every format-named bundle directory for a desktop target", async () => {
    const bundle = path.join(dir, "src-tauri", "target", "release", "bundle");
    const nsisDir = path.join(bundle, "nsis");
    const msiDir = path.join(bundle, "msi");
    await mkdir(nsisDir, { recursive: true });
    await mkdir(msiDir, { recursive: true });
    await writeFile(path.join(nsisDir, "app-setup.exe"), "x", "utf8");
    await writeFile(path.join(msiDir, "app.msi"), "x", "utf8");

    const result = await clean(dir, "windows");

    expect(existsSync(nsisDir)).toBe(false);
    expect(existsSync(msiDir)).toBe(false);
    expect(result.removed).toEqual([path.resolve(nsisDir), path.resolve(msiDir)]);
  });

  it("removes the whole projectDir when target is omitted", async () => {
    await writeFile(path.join(dir, "marker"), "x", "utf8");

    const result = await clean(dir);

    expect(existsSync(dir)).toBe(false);
    expect(result.removed).toEqual([path.resolve(dir)]);
  });
});

// ---------------------------------------------------------------------------
// isClearableBuildOutput — the containment gate in front of the iOS build-output
// remove. Pure predicate: every refusal below is asserted on plain strings, never by
// pointing the destructive function at an unsafe path.
// ---------------------------------------------------------------------------

const projectRoot = path.join(cwd, ".moku", "tauri");
const iosBuildOutput = path.join(projectRoot, "src-tauri", "gen", "apple", "build");

describe.each(PLATFORMS)("isClearableBuildOutput on %s", platform => {
  const boundaries = { cwd, home, platform };

  it("accepts a build directory nested inside a derived projectDir", () => {
    expect(isClearableBuildOutput(projectRoot, iosBuildOutput, boundaries)).toBe(true);
  });

  it("refuses a candidate that IS the projectDir", () => {
    expect(isClearableBuildOutput(projectRoot, projectRoot, boundaries)).toBe(false);
  });

  it("refuses a candidate outside the projectDir", () => {
    expect(
      isClearableBuildOutput(projectRoot, path.join(path.sep, "elsewhere", "build"), boundaries)
    ).toBe(false);
  });

  it("refuses a sibling path with a shared prefix", () => {
    expect(isClearableBuildOutput(projectRoot, `${projectRoot}-evil`, boundaries)).toBe(false);
  });

  it("refuses every candidate when the projectDir is not derived state", () => {
    expect(isClearableBuildOutput(home, path.join(home, "build"), boundaries)).toBe(false);
  });
});

describe("mobileBuildOutputPath", () => {
  it("points at gen/apple/build for ios", () => {
    expect(mobileBuildOutputPath("/repo/.moku/tauri", "ios")).toBe(
      path.join("/repo/.moku/tauri", "src-tauri", "gen", "apple", "build")
    );
  });

  it("points nowhere for android — gradle owns its own outputs", () => {
    expect(mobileBuildOutputPath("/repo/.moku/tauri", "android")).toBeUndefined();
  });
});

describe("clearMobileBuildOutput", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-clear-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes the previous iOS build output", async () => {
    const buildDir = path.join(dir, "src-tauri", "gen", "apple", "build");
    await mkdir(path.join(buildDir, "MyApp_iOS.xcarchive"), { recursive: true });
    await writeFile(path.join(buildDir, "marker"), "x", "utf8");

    const result = await clearMobileBuildOutput(dir, "ios");

    expect(existsSync(buildDir)).toBe(false);
    expect(result.removed).toEqual([path.resolve(buildDir)]);
  });

  it("keeps the rest of the gen/apple tree", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(path.join(genDir, "build"), { recursive: true });
    await writeFile(path.join(genDir, "project.yml"), "name: MyApp\n", "utf8");

    await clearMobileBuildOutput(dir, "ios");

    expect(existsSync(path.join(genDir, "project.yml"))).toBe(true);
  });

  it("reports nothing removed when there is no previous build output", async () => {
    const result = await clearMobileBuildOutput(dir, "ios");
    expect(result.removed).toEqual([]);
  });

  it("removes nothing for android — gradle owns its own outputs", async () => {
    const buildDir = path.join(dir, "src-tauri", "gen", "android", "app", "build");
    await mkdir(buildDir, { recursive: true });

    const result = await clearMobileBuildOutput(dir, "android");

    expect(result.removed).toEqual([]);
    expect(existsSync(buildDir)).toBe(true);
  });

  it("refuses a build symlink pointing outside projectDir, and never follows it", async () => {
    // Both ends are mkdtemp workspaces: even a broken guard could only touch temp state.
    const outside = await mkdtemp(path.join(tmpdir(), "moku-native-outside-"));
    await writeFile(path.join(outside, "keep-me"), "x", "utf8");
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(genDir, { recursive: true });
    const link = path.join(genDir, "build");
    await symlink(outside, link, "dir");

    try {
      await expect(clearMobileBuildOutput(dir, "ios")).rejects.toThrow(
        "[native] Refusing to remove build output outside projectDir"
      );
      expect(existsSync(path.join(outside, "keep-me"))).toBe(true);
      expect(existsSync(link)).toBe(true);
    } finally {
      // Explicit unlink + rm of the link's own target: the symlink is never followed.
      await unlink(link);
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a DANGLING build symlink instead of reporting nothing to remove", async () => {
    // A dangling link is invisible to a stat that follows links, so it used to slip past the
    // guard entirely. It points at a path that was never created — nothing to follow.
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(genDir, { recursive: true });
    const link = path.join(genDir, "build");
    await symlink(path.join(dir, "never-created"), link, "dir");

    try {
      await expect(clearMobileBuildOutput(dir, "ios")).rejects.toThrow(
        "[native] Refusing to remove build output outside projectDir"
      );
      await expect(clearMobileBuildOutput(dir, "ios")).rejects.toThrow("must be a real directory");
      expect(existsSync(link)).toBe(false); // still dangling: the link was never replaced
    } finally {
      // Explicit unlink of the link itself: it is removed, never followed.
      await unlink(link);
    }
  });

  it("names the fix in the refusal's second line", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    await mkdir(genDir, { recursive: true });
    const outside = await mkdtemp(path.join(tmpdir(), "moku-native-outside-"));
    const link = path.join(genDir, "build");
    await symlink(outside, link, "dir");

    try {
      await expect(clearMobileBuildOutput(dir, "ios")).rejects.toThrow("Remove that link by hand");
    } finally {
      await unlink(link);
      await rmdir(outside);
    }
  });
});
