import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyPbxprojDeploymentTarget,
  applyPbxprojPrivacyManifest,
  applyProjectYmlDeploymentTarget,
  applyProjectYmlPrivacyManifest,
  patchDeploymentTarget,
  patchPrivacyManifest,
  readPrivacyManifest
} from "../../../mobile/ios-project";
import { REAL_PBXPROJ, REAL_PROJECT_YML } from "./fixtures";

/** The object `mainGroup` names in {@link REAL_PBXPROJ}: an unnamed group, not the first one. */
const REAL_MAIN_GROUP = "1C51F5B7984430FBC815FE11";

/** The `PBXResourcesBuildPhase` of {@link REAL_PBXPROJ}. */
const REAL_RESOURCES_PHASE = "215999D8FC9DA59D74CF3077";

/** What `tauri ios init` wrote into {@link REAL_PBXPROJ}, twice. */
const REAL_PBXPROJ_TARGET = "IPHONEOS_DEPLOYMENT_TARGET = 16.0;";

/** The `PBXBuildFile` line of the manifest; its groups are the two fixed ids. */
const BUILD_FILE_PATTERN =
  /^\t\t([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile; fileRef = ([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy \*\/; \};$/m;

/** Reads the two fixed ids back out of a patched pbxproj. */
const privacyIds = (pbxproj: string) => {
  const match = BUILD_FILE_PATTERN.exec(pbxproj);
  return { buildId: match?.[1] ?? "", fileId: match?.[2] ?? "" };
};

/** The text of one pbxproj section. */
const section = (pbxproj: string, name: string) =>
  pbxproj.slice(
    pbxproj.indexOf(`/* Begin ${name} section */`),
    pbxproj.indexOf(`/* End ${name} section */`)
  );

/** The text of the object `id` opens, up to its closing line. */
const objectBlock = (pbxproj: string, id: string) => {
  const start = pbxproj.search(new RegExp(String.raw`^\t\t${id}( /\*.*\*/)? = \{$`, "m"));
  return pbxproj.slice(start, pbxproj.indexOf("\n\t\t};", start));
};

/** The whole-word lines of a text that contain a needle. */
const linesWith = (text: string, needle: string) =>
  text.split("\n").filter(line => line.includes(needle));

/** The same text in CRLF. */
const crlf = (text: string) => text.replaceAll("\n", "\r\n");

describe("applyPbxprojDeploymentTarget", () => {
  it("rewrites every IPHONEOS_DEPLOYMENT_TARGET and nothing else (bug: MinimumOSVersion stays on the first init's value)", () => {
    expect(linesWith(REAL_PBXPROJ, REAL_PBXPROJ_TARGET)).toHaveLength(2);

    expect(applyPbxprojDeploymentTarget(REAL_PBXPROJ, "26.0")).toBe(
      REAL_PBXPROJ.replaceAll(REAL_PBXPROJ_TARGET, "IPHONEOS_DEPLOYMENT_TARGET = 26.0;")
    );
  });

  it("keeps CRLF byte for byte", () => {
    expect(applyPbxprojDeploymentTarget(crlf(REAL_PBXPROJ), "26.0")).toBe(
      crlf(REAL_PBXPROJ).replaceAll(REAL_PBXPROJ_TARGET, "IPHONEOS_DEPLOYMENT_TARGET = 26.0;")
    );
  });

  it("is a no-op on a second pass", () => {
    const once = applyPbxprojDeploymentTarget(REAL_PBXPROJ, "26.0");

    expect(applyPbxprojDeploymentTarget(once, "26.0")).toBe(once);
  });

  it("refuses a file without such a line (bug: a silent no-op ships the old minimum)", () => {
    expect(() =>
      applyPbxprojDeploymentTarget(REAL_PBXPROJ.replaceAll(REAL_PBXPROJ_TARGET, ""), "26.0")
    ).toThrow(
      "[native] Could not find IPHONEOS_DEPLOYMENT_TARGET in project.pbxproj.\n  Run clean for ios and build again, or report the project.pbxproj Tauri generated."
    );
  });
});

describe("applyProjectYmlDeploymentTarget", () => {
  it("rewrites deploymentTarget.iOS and nothing else (bug: a later xcodegen brings the old minimum back)", () => {
    expect(applyProjectYmlDeploymentTarget(REAL_PROJECT_YML, "26.0")).toBe(
      REAL_PROJECT_YML.replace("    iOS: 16.0\n", "    iOS: 26.0\n")
    );
  });

  it("keeps CRLF byte for byte", () => {
    expect(applyProjectYmlDeploymentTarget(crlf(REAL_PROJECT_YML), "26.0")).toBe(
      crlf(REAL_PROJECT_YML).replace("    iOS: 16.0\r\n", "    iOS: 26.0\r\n")
    );
  });

  it("is a no-op on a second pass", () => {
    const once = applyProjectYmlDeploymentTarget(REAL_PROJECT_YML, "26.0");

    expect(applyProjectYmlDeploymentTarget(once, "26.0")).toBe(once);
  });

  it("finds the iOS entry below a sibling platform", () => {
    const yml = "options:\n  deploymentTarget:\n    macOS: 12.0\n\n    iOS: 16.0\nname: app\n";

    expect(applyProjectYmlDeploymentTarget(yml, "26.0")).toBe(
      "options:\n  deploymentTarget:\n    macOS: 12.0\n\n    iOS: 26.0\nname: app\n"
    );
  });

  it.each([
    ["no block at all", "name: app\ntargets:\n"],
    ["a block without an iOS entry", "options:\n  deploymentTarget:\n    macOS: 12.0\n"],
    [
      "an iOS key outside the block",
      "options:\n  deploymentTarget:\n    macOS: 12.0\n  iOS: 16.0\n"
    ]
  ])("refuses %s (bug: a silent no-op ships the old minimum)", (_label, yml) => {
    expect(() => applyProjectYmlDeploymentTarget(yml, "26.0")).toThrow(
      "[native] Could not find deploymentTarget.iOS in project.yml.\n  Run clean for ios and build again, or report the project.yml Tauri generated."
    );
  });
});

describe("applyPbxprojPrivacyManifest", () => {
  const patched = applyPbxprojPrivacyManifest(REAL_PBXPROJ, true);
  const { buildId, fileId } = privacyIds(patched);

  it("adds exactly four lines around two fixed 24-hex ids", () => {
    expect(buildId).toMatch(/^[0-9A-F]{24}$/);
    expect(fileId).toMatch(/^[0-9A-F]{24}$/);
    expect(buildId).not.toBe(fileId);
    expect(patched.split("\n")).toHaveLength(REAL_PBXPROJ.split("\n").length + 4);
    expect(linesWith(patched, buildId)).toHaveLength(2);
    expect(linesWith(patched, fileId)).toHaveLength(3);
  });

  it("writes the build file and the file reference into their sections (bug: Xcode reads a dangling id and drops the file)", () => {
    expect(section(patched, "PBXBuildFile")).toContain(`${buildId} /* PrivacyInfo.xcprivacy in`);
    expect(section(patched, "PBXFileReference")).toContain(
      `\t\t${fileId} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n`
    );
  });

  it("adds the file to the group mainGroup names, and to no other (bug: the file resolves below a subgroup's path)", () => {
    const child = `\t\t\t\t${fileId} /* PrivacyInfo.xcprivacy */,\n`;

    expect(objectBlock(patched, REAL_MAIN_GROUP)).toContain(child);
    expect(section(patched, "PBXGroup").split(child)).toHaveLength(2);
  });

  it("reads mainGroup when the group carries a name, as Xcode writes it", () => {
    const named = REAL_PBXPROJ.replace(
      `mainGroup = ${REAL_MAIN_GROUP};`,
      `mainGroup = ${REAL_MAIN_GROUP} /* App */;`
    ).replace(`\t\t${REAL_MAIN_GROUP} = {`, `\t\t${REAL_MAIN_GROUP} /* App */ = {`);

    const block = objectBlock(applyPbxprojPrivacyManifest(named, true), REAL_MAIN_GROUP);

    expect(block).toContain(`${fileId} /* PrivacyInfo.xcprivacy */,`);
  });

  it("copies the file in the Resources phase (bug: the manifest is not in the bundle)", () => {
    expect(objectBlock(patched, REAL_RESOURCES_PHASE)).toContain(
      `\t\t\t\t${buildId} /* PrivacyInfo.xcprivacy in Resources */,\n`
    );
  });

  it("is a no-op on a second pass", () => {
    expect(applyPbxprojPrivacyManifest(patched, true)).toBe(patched);
  });

  it("removes everything to the exact original bytes (bug: a dropped option leaves Xcode a reference to a deleted file)", () => {
    expect(applyPbxprojPrivacyManifest(patched, false)).toBe(REAL_PBXPROJ);
  });

  it("keeps CRLF on the way in and on the way out", () => {
    const added = applyPbxprojPrivacyManifest(crlf(REAL_PBXPROJ), true);

    expect(added).toBe(crlf(patched));
    expect(applyPbxprojPrivacyManifest(added, false)).toBe(crlf(REAL_PBXPROJ));
  });

  it("leaves a file that never carried it alone, whatever anchors it lacks", () => {
    expect(applyPbxprojPrivacyManifest("// !$*UTF8*$!\n{\n}\n", false)).toBe(
      "// !$*UTF8*$!\n{\n}\n"
    );
  });

  it.each([
    [
      "the PBXBuildFile section",
      "/* End PBXBuildFile section */",
      "the PBXBuildFile section",
      "/* Gone */"
    ],
    [
      "the PBXFileReference section",
      "/* Begin PBXFileReference section */",
      "the PBXFileReference section",
      "/* Gone */"
    ],
    ["the PBXProject section", "/* Begin PBXProject section */", "the PBXProject section", "/* */"],
    ["the PBXGroup section", "/* End PBXGroup section */", "the PBXGroup section", "/* Gone */"],
    ["the mainGroup line", `mainGroup = ${REAL_MAIN_GROUP};`, "mainGroup", "gone = 1;"],
    [
      "the main group itself",
      `\t\t${REAL_MAIN_GROUP} = {`,
      `the main group ${REAL_MAIN_GROUP}`,
      "\t\tGone = {"
    ],
    [
      "the Resources phase",
      "/* Begin PBXResourcesBuildPhase section */",
      "the PBXResourcesBuildPhase section",
      "/* Gone */"
    ]
  ])("refuses a file without %s (bug: a silent skip ships no manifest)", (_label, anchor, name, swapped) => {
    expect(() => applyPbxprojPrivacyManifest(REAL_PBXPROJ.replace(anchor, swapped), true)).toThrow(
      `[native] Could not find ${name} in project.pbxproj.\n  Run clean for ios and build again, or report the project.pbxproj Tauri generated.`
    );
  });

  it("refuses a Resources phase without a files list", () => {
    const phase = section(REAL_PBXPROJ, "PBXResourcesBuildPhase");

    expect(() =>
      applyPbxprojPrivacyManifest(
        REAL_PBXPROJ.replace(phase, phase.replace("files = (", "others = (")),
        true
      )
    ).toThrow("[native] Could not find the PBXResourcesBuildPhase files in project.pbxproj.");
  });

  it("refuses a main group without children, never borrowing the next group's list (bug: the file resolves below a subgroup's path)", () => {
    const group = objectBlock(REAL_PBXPROJ, REAL_MAIN_GROUP);

    expect(() =>
      applyPbxprojPrivacyManifest(
        REAL_PBXPROJ.replace(group, group.replace("children = (", "others = (")),
        true
      )
    ).toThrow(
      `[native] Could not find the children of the main group ${REAL_MAIN_GROUP} in project.pbxproj.`
    );
  });
});

describe("applyProjectYmlPrivacyManifest", () => {
  const entry = "      - path: PrivacyInfo.xcprivacy\n        buildPhase: resources\n";
  const patched = applyProjectYmlPrivacyManifest(REAL_PROJECT_YML, true);

  it("adds the entry to the first sources under targets, never targetTemplates (bug: the app target never gets the file)", () => {
    const targets = REAL_PROJECT_YML.indexOf("\ntargets:\n");
    const sources = REAL_PROJECT_YML.indexOf("    sources:\n", targets) + "    sources:\n".length;

    expect(patched).toBe(
      `${REAL_PROJECT_YML.slice(0, sources)}${entry}${REAL_PROJECT_YML.slice(sources)}`
    );
  });

  it("is a no-op on a second pass", () => {
    expect(applyProjectYmlPrivacyManifest(patched, true)).toBe(patched);
  });

  it("removes the entry to the exact original bytes, the assets buildPhase kept (bug: every `buildPhase: resources` goes with it)", () => {
    expect(applyProjectYmlPrivacyManifest(patched, false)).toBe(REAL_PROJECT_YML);
  });

  it("keeps CRLF on the way in and on the way out", () => {
    const added = applyProjectYmlPrivacyManifest(crlf(REAL_PROJECT_YML), true);

    expect(added).toBe(crlf(patched));
    expect(applyProjectYmlPrivacyManifest(added, false)).toBe(crlf(REAL_PROJECT_YML));
  });

  it("follows the indentation of the list it joins", () => {
    const yml = "targets:\n  app:\n    sources:\n    - path: Sources\n";

    expect(applyProjectYmlPrivacyManifest(yml, true)).toBe(
      "targets:\n  app:\n    sources:\n    - path: PrivacyInfo.xcprivacy\n      buildPhase: resources\n    - path: Sources\n"
    );
  });

  it("leaves a file that never carried it alone, whatever anchors it lacks", () => {
    expect(applyProjectYmlPrivacyManifest("name: app\n", false)).toBe("name: app\n");
  });

  it.each([
    ["no targets", "targetTemplates:\n  app:\n    sources:\n      - path: Sources\n"],
    ["a target without sources", "targets:\n  app:\n    type: application\n"],
    ["sources that are not a list", "targets:\n  app:\n    sources:\n    settings: {}\n"]
  ])("refuses %s (bug: a silent skip ships no manifest after an xcodegen)", (_label, yml) => {
    expect(() => applyProjectYmlPrivacyManifest(yml, true)).toThrow(
      "[native] Could not find the target's sources list in project.yml.\n  Run clean for ios and build again, or report the project.yml Tauri generated."
    );
  });
});

describe("readPrivacyManifest", () => {
  it("reads nothing when the option is unset", async () => {
    await expect(readPrivacyManifest(undefined)).resolves.toBeUndefined();
  });

  it("refuses a source that is not there, naming it", async () => {
    await expect(readPrivacyManifest("/nowhere/PrivacyInfo.xcprivacy")).rejects.toThrow(
      '[native] ios.privacyManifest "/nowhere/PrivacyInfo.xcprivacy" was not found.\n  Point config.ios.privacyManifest at the manifest file, or unset it.'
    );
  });
});

describe("the iOS project passes", () => {
  /** A real binary plist header: a text read would corrupt these bytes. */
  const BINARY_MANIFEST = new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0xff, 0xfe, 0x00]);

  let dir: string;
  let genDir: string;
  let ymlPath: string;
  let pbxprojPath: string;
  let manifestPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-ios-project-"));
    genDir = path.join(dir, "src-tauri", "gen", "apple");
    ymlPath = path.join(genDir, "project.yml");
    pbxprojPath = path.join(genDir, "store-probe.xcodeproj", "project.pbxproj");
    manifestPath = path.join(genDir, "PrivacyInfo.xcprivacy");
    await mkdir(path.dirname(pbxprojPath), { recursive: true });
    await writeFile(ymlPath, REAL_PROJECT_YML, "utf8");
    await writeFile(pbxprojPath, REAL_PBXPROJ, "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("patchDeploymentTarget", () => {
    it("reaches both files, then reports both unchanged", async () => {
      const first = await patchDeploymentTarget(dir, genDir, "26.0");

      expect(first.patched.toSorted()).toEqual([pbxprojPath, ymlPath].toSorted());
      expect(await readFile(ymlPath, "utf8")).toContain("    iOS: 26.0\n");
      expect(await readFile(pbxprojPath, "utf8")).toContain("IPHONEOS_DEPLOYMENT_TARGET = 26.0;");

      const second = await patchDeploymentTarget(dir, genDir, "26.0");

      expect(second.patched).toEqual([]);
      expect(second.unchanged.toSorted()).toEqual([pbxprojPath, ymlPath].toSorted());
    });

    it("writes neither file when one of them refuses (bug: the two files disagree on the minimum)", async () => {
      await writeFile(pbxprojPath, "// !$*UTF8*$!\n", "utf8");

      await expect(patchDeploymentTarget(dir, genDir, "26.0")).rejects.toThrow(
        "[native] Could not find IPHONEOS_DEPLOYMENT_TARGET in project.pbxproj."
      );
      expect(await readFile(ymlPath, "utf8")).toBe(REAL_PROJECT_YML);
    });
  });

  describe("patchPrivacyManifest", () => {
    it("copies the bytes and adds the entries, reporting all three (bug: a binary plist is corrupted on the way)", async () => {
      const first = await patchPrivacyManifest(dir, genDir, BINARY_MANIFEST);

      expect(first.patched.toSorted()).toEqual([manifestPath, pbxprojPath, ymlPath].toSorted());
      expect(new Uint8Array(await readFile(manifestPath))).toEqual(BINARY_MANIFEST);
      expect(await readFile(ymlPath, "utf8")).toContain("- path: PrivacyInfo.xcprivacy\n");
      expect(await readFile(pbxprojPath, "utf8")).toContain("PBXFileReference; lastKnownFileType");
    });

    it("reports all three unchanged on a second pass", async () => {
      await patchPrivacyManifest(dir, genDir, BINARY_MANIFEST);

      const second = await patchPrivacyManifest(dir, genDir, BINARY_MANIFEST);

      expect(second.patched).toEqual([]);
      expect(second.unchanged).toHaveLength(3);
    });

    it("removes the file and restores both project files when the option goes away", async () => {
      await patchPrivacyManifest(dir, genDir, BINARY_MANIFEST);

      const result = await patchPrivacyManifest(dir, genDir, undefined);

      expect(result.patched.toSorted()).toEqual([manifestPath, pbxprojPath, ymlPath].toSorted());
      expect(existsSync(manifestPath)).toBe(false);
      expect(await readFile(ymlPath, "utf8")).toBe(REAL_PROJECT_YML);
      expect(await readFile(pbxprojPath, "utf8")).toBe(REAL_PBXPROJ);
    });

    it("reports both project files unchanged on a tree that never had one", async () => {
      const result = await patchPrivacyManifest(dir, genDir, undefined);

      expect(result).toEqual({ patched: [], unchanged: expect.arrayContaining([ymlPath]) });
      expect(result.unchanged).toHaveLength(2);
    });

    it("writes nothing when an anchor is missing (bug: a manifest no project file names)", async () => {
      await writeFile(pbxprojPath, "// !$*UTF8*$!\n", "utf8");

      await expect(patchPrivacyManifest(dir, genDir, BINARY_MANIFEST)).rejects.toThrow(
        "[native] Could not find the PBXBuildFile section in project.pbxproj."
      );
      expect(existsSync(manifestPath)).toBe(false);
      expect(await readFile(ymlPath, "utf8")).toBe(REAL_PROJECT_YML);
    });

    it("writes nothing into a directory with no project file in it (bug: a stray file in a tree init never filled)", async () => {
      await rm(ymlPath);
      await rm(path.dirname(pbxprojPath), { recursive: true });

      const result = await patchPrivacyManifest(dir, genDir, BINARY_MANIFEST);

      expect(result).toEqual({ patched: [], unchanged: [] });
      expect(existsSync(manifestPath)).toBe(false);
    });
  });
});
