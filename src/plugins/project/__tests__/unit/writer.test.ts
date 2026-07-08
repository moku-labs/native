import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertWritablePath, writeIfChanged } from "../../writer";

describe("assertWritablePath", () => {
  it("allows a pure project file path", () => {
    expect(() => assertWritablePath(`/repo/.moku/tauri/src-tauri/tauri.conf.json`)).not.toThrow();
  });

  it.each([
    "target",
    ".gradle",
    "DerivedData",
    "Pods"
  ])("refuses a path through a %s segment", segment => {
    const forbidden = ["repo", ".moku", "tauri", "src-tauri", segment, "x"].join(path.sep);
    expect(() => assertWritablePath(forbidden)).toThrow("[native] Refusing to write");
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
    const action = await writeIfChanged(filePath, "hello");

    expect(action).toBe("written");
    expect(await readFile(filePath, "utf8")).toBe("hello");
  });

  it("writes when content differs from what's on disk", async () => {
    const filePath = path.join(dir, "file.txt");
    await writeFile(filePath, "old", "utf8");

    const action = await writeIfChanged(filePath, "new");

    expect(action).toBe("written");
    expect(await readFile(filePath, "utf8")).toBe("new");
  });

  it("does not rewrite unchanged content, preserving mtime", async () => {
    const filePath = path.join(dir, "file.txt");
    await writeFile(filePath, "same", "utf8");
    const before = await stat(filePath);

    // Ensure the filesystem's mtime resolution would detect a rewrite if one happened.
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));

    const action = await writeIfChanged(filePath, "same");
    const after = await stat(filePath);

    expect(action).toBe("unchanged");
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
