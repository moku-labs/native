import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { completeness, requiredFiles } from "../../completeness";

describe("requiredFiles", () => {
  it("returns a non-empty required set for ios", () => {
    expect(requiredFiles("ios").length).toBeGreaterThan(0);
  });

  it("returns a non-empty required set for android", () => {
    expect(requiredFiles("android").length).toBeGreaterThan(0);
  });
});

describe("completeness", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-completeness-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is not-applicable for desktop targets", () => {
    expect(completeness(dir, "macos")).toEqual({ status: "not-applicable" });
    expect(completeness(dir, "windows")).toEqual({ status: "not-applicable" });
    expect(completeness(dir, "linux")).toEqual({ status: "not-applicable" });
  });

  it("is not-initialized when gen/<platform> is absent", () => {
    expect(completeness(dir, "android")).toEqual({ status: "not-initialized" });
    expect(completeness(dir, "ios")).toEqual({ status: "not-initialized" });
  });

  it("is incomplete when only some required files exist (tauri#13902 partial init)", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "android");
    await mkdir(genDir, { recursive: true });
    await writeFile(path.join(genDir, "build.gradle.kts"), "// stub", "utf8");

    const result = completeness(dir, "android");

    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.missing).toContain("settings.gradle.kts");
      expect(result.missing).not.toContain("build.gradle.kts");
    }
  });

  it("is complete when every required file is present", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "android");
    for (const file of requiredFiles("android")) {
      const filePath = path.join(genDir, file);
      await mkdir(path.join(filePath, ".."), { recursive: true });
      await writeFile(filePath, "// stub", "utf8");
    }

    expect(completeness(dir, "android")).toEqual({ status: "complete" });
  });

  it("checks gen/apple for the ios target", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "apple");
    for (const file of requiredFiles("ios")) {
      const filePath = path.join(genDir, file);
      await mkdir(path.join(filePath, ".."), { recursive: true });
      await writeFile(filePath, "stub", "utf8");
    }

    expect(completeness(dir, "ios")).toEqual({ status: "complete" });
  });
});
