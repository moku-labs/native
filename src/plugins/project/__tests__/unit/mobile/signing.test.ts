import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applySigningBlock,
  patchAndroidSigning,
  removeSigningBlock
} from "../../../mobile/signing";
import { KEY_PASSWORD_ENV, SIGNING, SIGNING_BLOCK, STORE_PASSWORD_ENV } from "./fixtures";

describe("applySigningBlock", () => {
  it("appends the exact Gradle signing block when none is present", () => {
    expect(applySigningBlock("plugins {}\n", SIGNING)).toBe(`plugins {}\n\n${SIGNING_BLOCK}\n`);
  });

  it("appends a separator when the existing content has no trailing newline", () => {
    expect(applySigningBlock("plugins {}", SIGNING)).toBe(`plugins {}\n\n${SIGNING_BLOCK}\n`);
  });

  it("reads the key password from keyPasswordEnv when it is set", () => {
    const patched = applySigningBlock("plugins {}\n", {
      ...SIGNING,
      keyPasswordEnv: KEY_PASSWORD_ENV
    });
    expect(patched).toContain(`storePassword = System.getenv("${STORE_PASSWORD_ENV}")`);
    expect(patched).toContain(`keyPassword = System.getenv("${KEY_PASSWORD_ENV}")`);
  });

  it("is idempotent — re-applying produces the same content", () => {
    const once = applySigningBlock("plugins {}\n", SIGNING);
    expect(applySigningBlock(once, SIGNING)).toBe(once);
  });

  it("replaces a stale block rather than appending a second one", () => {
    const stale = applySigningBlock("plugins {}\n", { ...SIGNING, keyAlias: "old-alias" });
    const refreshed = applySigningBlock(stale, SIGNING);

    expect(refreshed.match(/MOKU-SIGNING-START/g)).toHaveLength(1);
    expect(refreshed).toContain('keyAlias = "release"');
    expect(refreshed).not.toContain('keyAlias = "old-alias"');
  });

  it("removes an existing block when no keystorePath is configured", () => {
    const patched = applySigningBlock("plugins {}\n", SIGNING);
    expect(applySigningBlock(patched, {})).toBe("plugins {}\n");
  });

  it("leaves unpatched content alone when no keystorePath is configured", () => {
    expect(applySigningBlock("plugins {}\n", {})).toBe("plugins {}\n");
  });

  it("escapes quotes, backslashes and Kotlin interpolation in the keystore path", () => {
    const patched = applySigningBlock("plugins {}\n", {
      ...SIGNING,
      keystorePath: String.raw`C:\keys\re"lease$HOME.jks`
    });

    expect(patched).toContain(String.raw`storeFile = file("C:\\keys\\re\"lease\$HOME.jks")`);
  });

  it("escapes a key alias that would otherwise close the Kotlin literal", () => {
    const patched = applySigningBlock("plugins {}\n", {
      ...SIGNING,
      keyAlias: 'release") ; evil("'
    });

    expect(patched).toContain(String.raw`keyAlias = "release\") ; evil(\""`);
  });

  it("escapes a newline instead of breaking the Kotlin literal across lines", () => {
    const patched = applySigningBlock("plugins {}\n", { ...SIGNING, keyAlias: "a\nb" });

    expect(patched).toContain(String.raw`keyAlias = "a\nb"`);
  });

  it("escapes an env-var name interpolated into System.getenv", () => {
    const patched = applySigningBlock("plugins {}\n", {
      ...SIGNING,
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a hostile env-var *name*, never a secret
      keystorePasswordEnv: 'KS") ?: evil("'
    });

    expect(patched).toContain(String.raw`storePassword = System.getenv("KS\") ?: evil(\"")`);
  });
});

describe("removeSigningBlock", () => {
  it("returns content that never carried a block unchanged", () => {
    expect(removeSigningBlock("plugins {}\n")).toBe("plugins {}\n");
  });

  it("keeps the content that follows the block", () => {
    const existing = `plugins {}\n\n${SIGNING_BLOCK}\ndependencies {}\n`;
    expect(removeSigningBlock(existing)).toBe("plugins {}\ndependencies {}\n");
  });

  it("returns only the trailing content when the block opened the file", () => {
    expect(removeSigningBlock(`${SIGNING_BLOCK}\ndependencies {}\n`)).toBe("dependencies {}\n");
  });
});

describe("patchAndroidSigning", () => {
  let dir: string;
  let genDir: string;
  let gradlePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-signing-"));
    genDir = path.join(dir, "src-tauri", "gen", "android");
    gradlePath = path.join(genDir, "app", "build.gradle.kts");
    await mkdir(path.join(genDir, "app"), { recursive: true });
    await writeFile(gradlePath, "plugins {}\n", "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the block on the first pass and reports it unchanged on the second", async () => {
    const first = await patchAndroidSigning(dir, genDir, SIGNING);
    expect(first).toEqual({ patched: [gradlePath], unchanged: [] });
    expect(await readFile(gradlePath, "utf8")).toBe(`plugins {}\n\n${SIGNING_BLOCK}\n`);

    const second = await patchAndroidSigning(dir, genDir, SIGNING);
    expect(second).toEqual({ patched: [], unchanged: [gradlePath] });
  });

  it("removes a legacy keystore.properties only when signing is unconfigured", async () => {
    const keystorePropertiesPath = path.join(genDir, "keystore.properties");
    await writeFile(keystorePropertiesPath, "storeFile=release.jks\n", "utf8");

    const configured = await patchAndroidSigning(dir, genDir, SIGNING);
    expect(configured.patched).not.toContain(keystorePropertiesPath);
    expect(existsSync(keystorePropertiesPath)).toBe(true);

    const unconfigured = await patchAndroidSigning(dir, genDir, {});
    expect(unconfigured.patched).toContain(keystorePropertiesPath);
    expect(existsSync(keystorePropertiesPath)).toBe(false);
  });
});
