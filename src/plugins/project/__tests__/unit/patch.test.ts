import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySigningBlock, patchMobile, renderKeystoreProperties } from "../../patch";

describe("renderKeystoreProperties", () => {
  it("renders configured fields", () => {
    const content = renderKeystoreProperties({
      keystorePath: "release.jks",
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- an env-var *name* reference, never a secret (SigningConfig invariant)
      keystorePasswordEnv: "KS_PASSWORD",
      keyAlias: "release"
    });
    expect(content).toContain("storeFile=release.jks");
    expect(content).toContain("keyAlias=release");
    expect(content).toContain("storePasswordEnvVar=KS_PASSWORD");
  });

  it("renders blank fields when unconfigured", () => {
    const content = renderKeystoreProperties({});
    expect(content).toContain("storeFile=");
  });
});

describe("applySigningBlock", () => {
  const signing = { keyAlias: "release", keystorePath: "release.jks" };

  it("inserts a signing block into content with none", () => {
    const patched = applySigningBlock('plugins {\n  id("com.android.application")\n}\n', signing);
    expect(patched).toContain("// MOKU-SIGNING-START");
    expect(patched).toContain("// MOKU-SIGNING-END");
    expect(patched).toContain('keyAlias = "release"');
  });

  it("is idempotent — re-applying produces the same content", () => {
    const once = applySigningBlock("plugins {}\n", signing);
    const twice = applySigningBlock(once, signing);

    expect(twice).toBe(once);
  });

  it("replaces a stale block rather than appending a second one", () => {
    const stale = applySigningBlock("plugins {}\n", { keyAlias: "old-alias" });
    const refreshed = applySigningBlock(stale, { keyAlias: "new-alias" });

    expect(refreshed.match(/MOKU-SIGNING-START/g)).toHaveLength(1);
    expect(refreshed).toContain('keyAlias = "new-alias"');
    expect(refreshed).not.toContain('keyAlias = "old-alias"');
  });
});

describe("patchMobile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-patch-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is a documented no-op for ios", async () => {
    const result = await patchMobile(dir, "ios", {});
    expect(result).toEqual({ patched: [], unchanged: [] });
  });

  it("throws when the android gen/ tree is missing", async () => {
    await expect(patchMobile(dir, "android", {})).rejects.toThrow(
      "[native] Android gen/ tree not found or incomplete"
    );
  });

  it("patches keystore.properties and build.gradle.kts, then is idempotent on re-run", async () => {
    const genDir = path.join(dir, "src-tauri", "gen", "android");
    await mkdir(path.join(genDir, "app"), { recursive: true });
    await writeFile(path.join(genDir, "app", "build.gradle.kts"), "plugins {}\n", "utf8");

    const signing = { android: { keyAlias: "release", keystorePath: "release.jks" } };
    const expectedPaths = [
      path.join(genDir, "keystore.properties"),
      path.join(genDir, "app", "build.gradle.kts")
    ].toSorted();

    const first = await patchMobile(dir, "android", signing);
    expect(first.patched.toSorted()).toEqual(expectedPaths);
    expect(first.unchanged).toEqual([]);

    const second = await patchMobile(dir, "android", signing);
    expect(second.patched).toEqual([]);
    expect(second.unchanged.toSorted()).toEqual(expectedPaths);

    const gradleContent = await readFile(path.join(genDir, "app", "build.gradle.kts"), "utf8");
    expect(gradleContent.match(/MOKU-SIGNING-START/g)).toHaveLength(1);
  });
});
