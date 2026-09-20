import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AnchorProbe } from "../../paths";
import { comparableRealPath, containmentAnchor, isDeliveryPath, isDerivedPath } from "../../paths";

const CWD = path.join(path.sep, "repo", "app");
const HOME = path.join(path.sep, "Users", "alex");
const TEMP = path.join(path.sep, "tmp");
const FILESYSTEM_ROOT = path.parse(CWD).root;

/** Builds an anchor probe over a plain in-memory tree — no filesystem is touched. */
function probeFor(entries: Record<string, string>): AnchorProbe {
  return {
    hasEntry: target => Object.hasOwn(entries, target),
    readText: target => entries[target]
  };
}

/** The probe for a tree with no repository marker anywhere. */
const EMPTY_PROBE = probeFor({});

describe("containmentAnchor", () => {
  const monorepoCwd = path.join(path.sep, "repo", "packages", "app");
  const monorepoRoot = path.join(path.sep, "repo");

  it("anchors to the nearest ancestor carrying a .git entry", () => {
    const probe = probeFor({ [path.join(monorepoRoot, ".git")]: "" });

    expect(containmentAnchor(monorepoCwd, HOME, "linux", probe)).toBe(monorepoRoot);
  });

  it("anchors to the nearest ancestor whose package.json declares workspaces", () => {
    const probe = probeFor({
      [path.join(monorepoRoot, "package.json")]: '{ "workspaces": ["packages/*"] }'
    });

    expect(containmentAnchor(monorepoCwd, HOME, "linux", probe)).toBe(monorepoRoot);
  });

  it("ignores a package.json without a workspaces field", () => {
    const probe = probeFor({ [path.join(monorepoRoot, "package.json")]: '{ "name": "repo" }' });

    expect(containmentAnchor(monorepoCwd, HOME, "linux", probe)).toBe(monorepoCwd);
  });

  it("prefers the nearest marker over a further one", () => {
    const probe = probeFor({
      [path.join(monorepoRoot, ".git")]: "",
      [path.join(monorepoRoot, "packages", ".git")]: ""
    });

    expect(containmentAnchor(monorepoCwd, HOME, "linux", probe)).toBe(
      path.join(monorepoRoot, "packages")
    );
  });

  it("falls back to the cwd when no ancestor carries a marker", () => {
    expect(containmentAnchor(monorepoCwd, HOME, "linux", EMPTY_PROBE)).toBe(monorepoCwd);
  });

  it("never walks up to the home directory, even when home carries a marker", () => {
    const cwd = path.join(HOME, "scratch", "app");
    const probe = probeFor({ [path.join(HOME, ".git")]: "" });

    expect(containmentAnchor(cwd, HOME, "linux", probe)).toBe(cwd);
  });

  it("never walks up to a filesystem root, even when the root carries a marker", () => {
    const probe = probeFor({ [path.join(FILESYSTEM_ROOT, ".git")]: "" });

    expect(containmentAnchor(monorepoCwd, HOME, "linux", probe)).toBe(monorepoCwd);
  });
});

describe("isDerivedPath — anchored containment", () => {
  const monorepoCwd = path.join(path.sep, "repo", "packages", "app");
  const monorepoRoot = path.join(path.sep, "repo");
  const boundaries = {
    cwd: monorepoCwd,
    home: HOME,
    temporaryRoot: TEMP,
    platform: "linux" as const,
    anchor: monorepoRoot
  };

  it("accepts an absolute derived directory at the repository root", () => {
    expect(isDerivedPath(path.join(monorepoRoot, ".moku", "tauri"), boundaries)).toBe(true);
  });

  it("accepts a derived directory beside the package the script runs from", () => {
    expect(isDerivedPath(path.join(monorepoCwd, ".moku", "tauri"), boundaries)).toBe(true);
  });

  it("refuses the anchor itself", () => {
    expect(isDerivedPath(monorepoRoot, boundaries)).toBe(false);
  });

  it("refuses a directory that contains the cwd", () => {
    expect(isDerivedPath(path.join(monorepoRoot, "packages"), boundaries)).toBe(false);
  });

  it("refuses a directory outside the anchor", () => {
    expect(isDerivedPath(path.join(path.sep, "elsewhere", "build"), boundaries)).toBe(false);
  });
});

describe("isDerivedPath — a temp root only grants what it may", () => {
  const boundaries = { cwd: CWD, home: HOME, platform: "linux" as const, anchor: CWD };

  it("accepts a workspace under an ordinary temp root", () => {
    expect(
      isDerivedPath(path.join(TEMP, "moku-native-fixture"), {
        ...boundaries,
        temporaryRoot: TEMP
      })
    ).toBe(true);
  });

  it("grants nothing when TMPDIR is a filesystem root", () => {
    expect(
      isDerivedPath(path.join(HOME, "Documents"), {
        ...boundaries,
        temporaryRoot: FILESYSTEM_ROOT
      })
    ).toBe(false);
  });

  it("grants nothing when TMPDIR is the home directory", () => {
    expect(
      isDerivedPath(path.join(HOME, "work", "build"), { ...boundaries, temporaryRoot: HOME })
    ).toBe(false);
  });

  it("grants nothing when TMPDIR contains the home directory", () => {
    expect(
      isDerivedPath(path.join(HOME, "work", "build"), {
        ...boundaries,
        temporaryRoot: path.dirname(HOME)
      })
    ).toBe(false);
  });

  it("still grants a temp root that merely sits inside the home directory", () => {
    const temporaryRoot = path.join(HOME, "tmp");

    expect(
      isDerivedPath(path.join(temporaryRoot, "moku-native-fixture"), {
        ...boundaries,
        temporaryRoot
      })
    ).toBe(true);
  });
});

describe("isDeliveryPath", () => {
  const boundaries = { cwd: CWD, home: HOME, platform: "linux" as const };

  it.each([
    ["a directory inside the cwd", path.join(CWD, "dist-native")],
    ["a CI cache mount outside the cwd", path.join(path.sep, "cache", "artifacts")],
    ["a personal directory (never recursively cleaned)", path.join(HOME, "Documents", "builds")],
    ["the cwd itself", CWD]
  ])("accepts %s", (_label, candidate) => {
    expect(isDeliveryPath(candidate, boundaries)).toBe(true);
  });

  it.each([
    ["a filesystem root", FILESYSTEM_ROOT],
    ["the home directory", HOME],
    ["an ancestor of the home directory", path.dirname(HOME)],
    ["an ancestor of the cwd", path.dirname(CWD)]
  ])("refuses %s", (_label, candidate) => {
    expect(isDeliveryPath(candidate, boundaries)).toBe(false);
  });
});

describe("comparableRealPath", () => {
  it("folds case on a case-insensitive platform", () => {
    expect(comparableRealPath(path.join(path.sep, "Repo", "App"), "darwin")).toBe(
      path.join(path.sep, "repo", "app")
    );
  });

  it("preserves case on a case-sensitive platform", () => {
    expect(comparableRealPath(path.join(path.sep, "Repo", "App"), "linux")).toBe(
      path.join(path.sep, "Repo", "App")
    );
  });
});
