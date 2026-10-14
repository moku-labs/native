import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { patchAndroidProfile } from "../../../mobile/profile";
import type { AndroidProfile } from "../../../types";
import { androidManifest } from "./fixtures";

/** `res/values/strings.xml` as `tauri android init` writes it for "My App". */
const stringsXml = (name = "My App", lineEnding = "\n") =>
  [
    "<resources>",
    `    <string name="app_name">${name}</string>`,
    `    <string name="main_activity_title">${name}</string>`,
    "</resources>",
    ""
  ].join(lineEnding);

/** The first line of the network security config the debug profile writes. */
const NETWORK_MARKER = "<!-- moku:native debug profile -->";

/** The `<application>` attribute that points Android at that config. */
const NETWORK_ATTRIBUTE = 'android:networkSecurityConfig="@xml/network_security_config"';

/** The debug profile for `appName`, warnings collected by `warn`. */
const debug = (appName = "My App", warn = vi.fn()): AndroidProfile => ({
  profile: "debug",
  appName,
  debugKeystore: "/home/me/.android/debug.keystore",
  log: { warn }
});

/** The store profile, warnings collected by `warn`. */
const store = (warn = vi.fn()): AndroidProfile => ({ profile: "store", log: { warn } });

/** A hand-made network config, CRLF and all, at the path the debug profile writes to. */
const HAND_MADE_CONFIG =
  '<?xml version="1.0" encoding="utf-8"?>\r\n<network-security-config>\r\n  <domain-config cleartextTrafficPermitted="true"><domain>127.0.0.1</domain></domain-config>\r\n</network-security-config>\r\n';

/** The template manifest whose `<application>` names `resource` as its network config. */
const manifestNaming = (resource: string) =>
  androidManifest().replace(
    "    <application\n",
    `    <application\n        android:networkSecurityConfig="${resource}"\n`
  );

describe("patchAndroidProfile", () => {
  let dir: string;
  let genDir: string;
  let gradlePath: string;
  let stringsPath: string;
  let manifestPath: string;
  let networkPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-profile-"));
    genDir = path.join(dir, "src-tauri", "gen", "android");
    gradlePath = path.join(genDir, "app", "build.gradle.kts");
    stringsPath = path.join(genDir, "app", "src", "main", "res", "values", "strings.xml");
    manifestPath = path.join(genDir, "app", "src", "main", "AndroidManifest.xml");
    networkPath = path.join(
      genDir,
      "app",
      "src",
      "main",
      "res",
      "xml",
      "network_security_config.xml"
    );
    await mkdir(path.dirname(stringsPath), { recursive: true });
    await writeFile(gradlePath, "plugins {}\n", "utf8");
    await writeFile(stringsPath, stringsXml(), "utf8");
    await writeFile(manifestPath, androidManifest(), "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** One profile pass over the seeded tree. */
  const pass = (profile: AndroidProfile) =>
    patchAndroidProfile({ projectDirectory: dir, genDirectory: genDir, profile });

  it("debug adds the .debug id suffix; store restores the Gradle bytes exactly (bug: a store build installs as .debug)", async () => {
    await pass(debug());
    const patched = await readFile(gradlePath, "utf8");
    expect(patched).toContain("// MOKU-PROFILE-START");
    expect(patched).toContain('applicationIdSuffix = ".debug"');

    const again = await pass(debug());
    expect(again.unchanged).toContain(gradlePath);

    await pass(store());
    expect(await readFile(gradlePath, "utf8")).toBe("plugins {}\n");
  });

  it("debug names the app '<name> (debug)' escaped for aapt2; store restores the lines (bug: aapt2 rejects an unescaped apostrophe)", async () => {
    await writeFile(stringsPath, stringsXml("Tom's & Co"), "utf8");

    await pass(debug("Tom's & Co"));
    const patched = await readFile(stringsPath, "utf8");
    expect(patched).toContain("<!-- moku:native debug name");
    expect(patched).toContain(String.raw`<string name="app_name">Tom\'s &amp; Co (debug)</string>`);
    expect(patched).toContain(
      String.raw`<string name="main_activity_title">Tom\'s &amp; Co (debug)</string>`
    );

    await pass(store());
    expect(await readFile(stringsPath, "utf8")).toBe(stringsXml("Tom's & Co"));
  });

  it("store leaves a never-debugged strings.xml byte-identical and unwritten (bug: every existing tree rewritten)", async () => {
    const before = await stat(stringsPath);

    const result = await pass(store());

    expect(await readFile(stringsPath, "utf8")).toBe(stringsXml());
    const after = await stat(stringsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(result).toEqual({ patched: [], unchanged: [] });
  });

  it("debug's network config allows cleartext to every host (bug: the LAN editor cannot connect)", async () => {
    await pass(debug());

    const config = await readFile(networkPath, "utf8");
    expect(config.split("\n")[0]).toBe(NETWORK_MARKER);
    expect(config).toContain('<base-config cleartextTrafficPermitted="true"');
    expect(config).not.toContain("<domain-config");
  });

  it("debug points <application> at the network config; store removes the attribute and the file (bug: cleartext left in a store build)", async () => {
    await pass(debug());
    expect(await readFile(manifestPath, "utf8")).toContain(
      `<application\n        ${NETWORK_ATTRIBUTE}`
    );

    const result = await pass(store());

    expect(existsSync(networkPath)).toBe(false);
    expect(await readFile(manifestPath, "utf8")).toBe(androidManifest());
    expect(result.patched).toEqual(expect.arrayContaining([manifestPath, networkPath]));
  });

  it("store keeps a network config native did not write, with a warning (bug: D4 — a hand-made config deleted)", async () => {
    const handMade =
      '<network-security-config>\n  <base-config cleartextTrafficPermitted="false"/>\n</network-security-config>\n';
    await mkdir(path.dirname(networkPath), { recursive: true });
    await writeFile(networkPath, handMade, "utf8");
    const warn = vi.fn();

    await pass(store(warn));

    expect(await readFile(networkPath, "utf8")).toBe(handMade);
    expect(warn).toHaveBeenCalledWith(
      "project:patchMobile:foreign-network-config",
      expect.objectContaining({ path: networkPath })
    );
  });

  it("CRLF files keep CRLF through debug and come back byte for byte (bug: Windows-edited files churn)", async () => {
    await writeFile(gradlePath, "plugins {}\r\n", "utf8");
    await writeFile(stringsPath, stringsXml("My App", "\r\n"), "utf8");
    await writeFile(manifestPath, androidManifest(undefined, "\r\n"), "utf8");
    const bareLineFeed = /(?<!\r)\n/;

    await pass(debug());
    for (const file of [gradlePath, stringsPath, manifestPath]) {
      expect(await readFile(file, "utf8")).not.toMatch(bareLineFeed);
    }

    await pass(store());
    expect(await readFile(gradlePath, "utf8")).toBe("plugins {}\r\n");
    expect(await readFile(stringsPath, "utf8")).toBe(stringsXml("My App", "\r\n"));
    expect(await readFile(manifestPath, "utf8")).toBe(androidManifest(undefined, "\r\n"));
  });

  it.each([
    ["the same resource name (A Memory Missing's tree)", "@xml/network_security_config"],
    ["another resource name", "@xml/loopback"]
  ])("debug then store over a hand-made config naming %s restores file and manifest byte for byte (bug: the hand-made config deleted)", async (_label, resource) => {
    await mkdir(path.dirname(networkPath), { recursive: true });
    await writeFile(networkPath, HAND_MADE_CONFIG, "utf8");
    await writeFile(manifestPath, manifestNaming(resource), "utf8");

    await pass(debug());
    await pass(debug());
    expect(await readFile(networkPath, "utf8")).toContain(
      '<base-config cleartextTrafficPermitted="true"'
    );
    expect(await readFile(manifestPath, "utf8")).toContain(NETWORK_ATTRIBUTE);

    await pass(store());
    expect(await readFile(networkPath, "utf8")).toBe(HAND_MADE_CONFIG);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestNaming(resource));
  });

  it("store over a hand-made config keeps the attribute that names it (bug: the config silently disabled)", async () => {
    await mkdir(path.dirname(networkPath), { recursive: true });
    await writeFile(networkPath, HAND_MADE_CONFIG, "utf8");
    await writeFile(manifestPath, manifestNaming("@xml/network_security_config"), "utf8");
    const warn = vi.fn();

    const result = await pass(store(warn));

    expect(await readFile(manifestPath, "utf8")).toBe(
      manifestNaming("@xml/network_security_config")
    );
    expect(await readFile(networkPath, "utf8")).toBe(HAND_MADE_CONFIG);
    expect(result).toEqual({ patched: [], unchanged: [] });
    expect(warn).toHaveBeenCalledWith(
      "project:patchMobile:foreign-network-config",
      expect.objectContaining({ path: networkPath, action: "kept" })
    );
  });

  it("a multi-line app_name comes back byte for byte with the lines after it (bug: following lines eaten, aapt2 fails)", async () => {
    const strings = [
      "<resources>",
      '    <string name="app_name">',
      "        Demo",
      "    </string>",
      '    <string name="other">Keep</string>',
      "</resources>",
      ""
    ].join("\n");
    await writeFile(stringsPath, strings, "utf8");

    await pass(debug("Demo"));
    expect(await readFile(stringsPath, "utf8")).toContain(
      '<string name="app_name">Demo (debug)</string>'
    );

    await pass(store());
    expect(await readFile(stringsPath, "utf8")).toBe(strings);
  });
});
