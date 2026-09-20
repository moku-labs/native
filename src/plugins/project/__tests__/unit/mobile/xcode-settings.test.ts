import { describe, expect, it } from "vitest";

import {
  applyPbxprojEntitlementsSetting,
  applyProjectYmlEntitlementsSetting,
  ENTITLEMENTS_MODIFICATION_KEY
} from "../../../mobile/xcode-settings";

/** The pbxproj form of the setting, at the indentation `tauri ios init` writes settings with. */
const PBXPROJ_SETTING = `\t\t\t\t${ENTITLEMENTS_MODIFICATION_KEY} = YES;`;

/** The project.yml form, at the indentation xcodegen writes `settings.base` entries with. */
const YML_SETTING = `        ${ENTITLEMENTS_MODIFICATION_KEY}: true`;

/**
 * One `XCBuildConfiguration` block exactly as `tauri ios init` writes it: tab-indented,
 * `buildSettings = {` three tabs deep, its settings four.
 *
 * @param name - The configuration name (`debug`/`release`).
 * @param settings - The setting lines inside the block, without indentation.
 * @returns The block's lines.
 */
function configurationBlock(name: string, settings: readonly string[]): string[] {
  return [
    `\t\t4181446B2551BCC2AAFE142D /* ${name} */ = {`,
    "\t\t\tisa = XCBuildConfiguration;",
    "\t\t\tbuildSettings = {",
    ...settings.map(setting => `\t\t\t\t${setting}`),
    "\t\t\t};",
    `\t\t\tname = ${name};`,
    "\t\t};"
  ];
}

/** The four settings blocks a generated iOS project carries: two target, two project. */
const TARGET_SETTINGS = [
  "ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES = YES;",
  "ARCHS = (",
  "\tarm64,",
  ");",
  'CODE_SIGN_ENTITLEMENTS = "MyApp_iOS/MyApp_iOS.entitlements";',
  'CODE_SIGN_IDENTITY = "iPhone Developer";',
  "ENABLE_BITCODE = NO;"
];

const PROJECT_SETTINGS = [
  "ALWAYS_SEARCH_USER_PATHS = NO;",
  "CLANG_ANALYZER_NONNULL = YES;",
  'CLANG_CXX_LIBRARY = "libc++";'
];

/**
 * A realistic `project.pbxproj`: the shell-script build phase above, then the four
 * `XCBuildConfiguration` blocks `tauri ios init` generates.
 *
 * @param settings - The setting lines for every block (without indentation).
 * @param settings.target - The two target configuration blocks' settings.
 * @param settings.project - The two project configuration blocks' settings.
 * @returns The file content, newline-terminated.
 */
function pbxprojFixture(settings: {
  target: readonly string[];
  project: readonly string[];
}): string {
  return [
    "// !$*UTF8*$!",
    "{",
    "\tarchiveVersion = 1;",
    "\tobjects = {",
    "/* Begin PBXShellScriptBuildPhase section */",
    '\t\t\tshellScript = "node tauri ios xcode-script -v";',
    "/* End PBXShellScriptBuildPhase section */",
    "",
    "/* Begin XCBuildConfiguration section */",
    ...configurationBlock("release", settings.target),
    ...configurationBlock("debug", settings.target),
    ...configurationBlock("release", settings.project),
    ...configurationBlock("debug", settings.project),
    "/* End XCBuildConfiguration section */",
    "\t};",
    "}",
    ""
  ].join("\n");
}

/** The generated file, before any patch pass. */
const PBXPROJ = pbxprojFixture({ target: TARGET_SETTINGS, project: PROJECT_SETTINGS });

/** The same file with the setting already first in every block — the hand-patched shape. */
const PATCHED_PBXPROJ = pbxprojFixture({
  target: [`${ENTITLEMENTS_MODIFICATION_KEY} = YES;`, ...TARGET_SETTINGS],
  project: [`${ENTITLEMENTS_MODIFICATION_KEY} = YES;`, ...PROJECT_SETTINGS]
});

/**
 * A realistic `gen/apple/project.yml`: a `settingGroups` block whose `base:` is NOT a
 * target's, and the target's own `settings.base`.
 *
 * @param baseEntries - The entries inside the target's `settings.base` block.
 * @returns The file content, newline-terminated.
 */
function projectYmlFixture(baseEntries: readonly string[]): string {
  return [
    "name: MyApp",
    "settingGroups:",
    "  app:",
    "    base:",
    "      PRODUCT_NAME: MyApp",
    "targets:",
    "  MyApp_iOS:",
    "    type: application",
    "    platform: iOS",
    "    settings:",
    "      base:",
    ...baseEntries.map(entry => `        ${entry}`),
    "      groups: [app]",
    "    dependencies:",
    "      - framework: libapp.a",
    ""
  ].join("\n");
}

/** The target's own settings, as `tauri ios init` writes them. */
const YML_BASE_ENTRIES = [
  "ENABLE_BITCODE: false",
  "ARCHS: [arm64]",
  "ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES: true"
];

const PROJECT_YML = projectYmlFixture(YML_BASE_ENTRIES);

describe("applyPbxprojEntitlementsSetting", () => {
  it("adds the setting to every buildSettings block at the siblings' indentation", () => {
    const patched = applyPbxprojEntitlementsSetting(PBXPROJ);

    expect(patched).toBe(PATCHED_PBXPROJ);
    expect(patched.split("\n").filter(line => line === PBXPROJ_SETTING)).toHaveLength(4);
  });

  it("reports a hand-patched file as unchanged — the setting is never duplicated", () => {
    expect(applyPbxprojEntitlementsSetting(PATCHED_PBXPROJ)).toBe(PATCHED_PBXPROJ);
  });

  it("is idempotent across repeated passes", () => {
    const once = applyPbxprojEntitlementsSetting(PBXPROJ);

    expect(applyPbxprojEntitlementsSetting(once)).toBe(once);
  });

  it("rewrites a block that disables the setting", () => {
    const disabled = pbxprojFixture({
      target: [`${ENTITLEMENTS_MODIFICATION_KEY} = NO;`, ...TARGET_SETTINGS],
      project: [`${ENTITLEMENTS_MODIFICATION_KEY} = NO;`, ...PROJECT_SETTINGS]
    });

    expect(applyPbxprojEntitlementsSetting(disabled)).toBe(PATCHED_PBXPROJ);
  });

  it("keeps CRLF line endings byte for byte", () => {
    const crlf = PBXPROJ.replaceAll("\n", "\r\n");

    const patched = applyPbxprojEntitlementsSetting(crlf);

    expect(patched).toBe(PATCHED_PBXPROJ.replaceAll("\n", "\r\n"));
    expect(patched).not.toMatch(/[^\r]\n/);
  });

  it("fills an empty buildSettings block one level deeper than the block itself", () => {
    const empty = [
      "\t\tABC /* release */ = {",
      "\t\t\tbuildSettings = {",
      "\t\t\t};",
      "\t\t};",
      ""
    ];

    expect(applyPbxprojEntitlementsSetting(empty.join("\n")).split("\n")[2]).toBe(PBXPROJ_SETTING);
  });

  it("leaves everything outside a buildSettings block untouched", () => {
    const patched = applyPbxprojEntitlementsSetting(PBXPROJ);

    expect(patched).toContain('\t\t\tshellScript = "node tauri ios xcode-script -v";');
    expect(patched).toContain("\tarchiveVersion = 1;");
  });

  it("leaves a file without a single buildSettings block untouched", () => {
    const unrelated = "// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n}\n";

    expect(applyPbxprojEntitlementsSetting(unrelated)).toBe(unrelated);
  });
});

describe("applyProjectYmlEntitlementsSetting", () => {
  it("adds the setting to the target's settings.base at the siblings' indentation", () => {
    const patched = applyProjectYmlEntitlementsSetting(PROJECT_YML);

    expect(patched).toBe(
      projectYmlFixture([`${ENTITLEMENTS_MODIFICATION_KEY}: true`, ...YML_BASE_ENTRIES])
    );
    expect(patched.split("\n").filter(line => line === YML_SETTING)).toHaveLength(1);
  });

  it("is idempotent across repeated passes", () => {
    const once = applyProjectYmlEntitlementsSetting(PROJECT_YML);

    expect(applyProjectYmlEntitlementsSetting(once)).toBe(once);
  });

  it("never touches a settingGroups base block — only a target's settings.base", () => {
    const patched = applyProjectYmlEntitlementsSetting(PROJECT_YML);

    expect(patched).toContain("  app:\n    base:\n      PRODUCT_NAME: MyApp\n");
  });

  it("keeps CRLF line endings byte for byte", () => {
    const crlf = PROJECT_YML.replaceAll("\n", "\r\n");

    const patched = applyProjectYmlEntitlementsSetting(crlf);

    expect(patched).toContain(`${YML_SETTING}\r\n`);
    expect(patched).not.toMatch(/[^\r]\n/);
  });

  it("finds a base: that sits below another key inside the same settings block", () => {
    const groupsFirst = [
      "targets:",
      "  MyApp_iOS:",
      "    settings:",
      "      groups: [app]",
      "      base:",
      "        ENABLE_BITCODE: false",
      ""
    ];

    const patched = applyProjectYmlEntitlementsSetting(groupsFirst.join("\n"));

    expect(patched).toBe(
      [
        "targets:",
        "  MyApp_iOS:",
        "    settings:",
        "      groups: [app]",
        "      base:",
        YML_SETTING,
        "        ENABLE_BITCODE: false",
        ""
      ].join("\n")
    );
    expect(patched.split("\n").filter(line => line === YML_SETTING)).toHaveLength(1);
  });

  it("sees a setting separated from its siblings by a blank line — no duplicate key", () => {
    // A blank line does not end a YAML mapping: the entry below it is still in settings.base.
    const withBlankLine = [
      "targets:",
      "  MyApp_iOS:",
      "    settings:",
      "      base:",
      "        ENABLE_BITCODE: false",
      "",
      YML_SETTING,
      ""
    ].join("\n");

    const patched = applyProjectYmlEntitlementsSetting(withBlankLine);

    expect(patched).toBe(withBlankLine);
    expect(patched.split("\n").filter(line => line === YML_SETTING)).toHaveLength(1);
  });

  it("leaves a project.yml whose targets carry no settings.base untouched", () => {
    const withoutBase = ["targets:", "  MyApp_iOS:", "    settings:", "      groups: [app]", ""];

    expect(applyProjectYmlEntitlementsSetting(withoutBase.join("\n"))).toBe(withoutBase.join("\n"));
  });
});
