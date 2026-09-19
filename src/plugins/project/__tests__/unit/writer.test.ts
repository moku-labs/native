import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertWritablePath, writeIfChanged } from "../../writer";

const PROJECT_ROOT = path.join(path.sep, "repo", ".moku", "tauri");

describe("assertWritablePath", () => {
  it("allows a pure project file path", () => {
    expect(() =>
      assertWritablePath(path.join(PROJECT_ROOT, "src-tauri", "tauri.conf.json"), PROJECT_ROOT)
    ).not.toThrow();
  });

  it.each([
    "target",
    ".gradle",
    "DerivedData",
    "Pods"
  ])("refuses a path through a %s segment below projectDir", segment => {
    const forbidden = path.join(PROJECT_ROOT, "src-tauri", segment, "x");
    expect(() => assertWritablePath(forbidden, PROJECT_ROOT)).toThrow("[native] Refusing to write");
  });

  it("scans only below projectDir — a repo checked out under a dir named target is fine", () => {
    const root = path.join(path.sep, "Users", "alex", "target", "repo", ".moku", "tauri");
    expect(() =>
      assertWritablePath(path.join(root, "src-tauri", "tauri.conf.json"), root)
    ).not.toThrow();
  });
});

describe("writeIfChanged", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-writer-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a brand-new file", async () => {
    const filePath = path.join(dir, "nested", "new.txt");
    const action = await writeIfChanged(filePath, "hello", dir);

    expect(action).toBe("written");
    expect(await readFile(filePath, "utf8")).toBe("hello");
  });

  it("writes when content differs from what's on disk", async () => {
    const filePath = path.join(dir, "file.txt");
    await writeFile(filePath, "old", "utf8");

    const action = await writeIfChanged(filePath, "new", dir);

    expect(action).toBe("written");
    expect(await readFile(filePath, "utf8")).toBe("new");
  });

  it("does not rewrite unchanged content, preserving mtime", async () => {
    const filePath = path.join(dir, "file.txt");
    await writeFile(filePath, "same", "utf8");
    const before = await stat(filePath);

    // Ensure the filesystem's mtime resolution would detect a rewrite if one happened.
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));

    const action = await writeIfChanged(filePath, "same", dir);
    const after = await stat(filePath);

    expect(action).toBe("unchanged");
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("round-trips binary content byte-for-byte and diffs it too", async () => {
    const filePath = path.join(dir, "icon.png");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]);

    expect(await writeIfChanged(filePath, bytes, dir)).toBe("written");
    expect(new Uint8Array(await readFile(filePath))).toEqual(bytes);
    expect(await writeIfChanged(filePath, bytes, dir)).toBe("unchanged");
  });
});
