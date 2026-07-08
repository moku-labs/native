import { describe, expect, it } from "vitest";
import { buildArgv, devArgv, iconArgv, infoArgv, mobileInitArgv } from "../../argv";

const NODE = "/usr/bin/node";
const TAURI_JS = "/proj/node_modules/@tauri-apps/cli/tauri.js";

describe("buildArgv", () => {
  it("builds desktop targets uniformly", () => {
    expect(buildArgv(NODE, TAURI_JS, "macos")).toEqual([NODE, TAURI_JS, "build", "--ci"]);
    expect(buildArgv(NODE, TAURI_JS, "windows")).toEqual([NODE, TAURI_JS, "build", "--ci"]);
    expect(buildArgv(NODE, TAURI_JS, "linux")).toEqual([NODE, TAURI_JS, "build", "--ci"]);
  });

  it("builds ios with the ios subcommand", () => {
    expect(buildArgv(NODE, TAURI_JS, "ios")).toEqual([NODE, TAURI_JS, "ios", "build", "--ci"]);
  });

  it("builds android with the apk artifact flag", () => {
    expect(buildArgv(NODE, TAURI_JS, "android")).toEqual([
      NODE,
      TAURI_JS,
      "android",
      "build",
      "--ci",
      "--apk"
    ]);
  });
});

describe("devArgv", () => {
  it("defaults to desktop dev when no target is given", () => {
    expect(devArgv(NODE, TAURI_JS)).toEqual([NODE, TAURI_JS, "dev", "--ci"]);
  });

  it("builds desktop targets uniformly", () => {
    expect(devArgv(NODE, TAURI_JS, "macos")).toEqual([NODE, TAURI_JS, "dev", "--ci"]);
    expect(devArgv(NODE, TAURI_JS, "windows")).toEqual([NODE, TAURI_JS, "dev", "--ci"]);
    expect(devArgv(NODE, TAURI_JS, "linux")).toEqual([NODE, TAURI_JS, "dev", "--ci"]);
  });

  it("builds ios dev without --ci (CLI drives TAURI_DEV_HOST itself)", () => {
    expect(devArgv(NODE, TAURI_JS, "ios")).toEqual([NODE, TAURI_JS, "ios", "dev"]);
  });

  it("builds android dev without --ci", () => {
    expect(devArgv(NODE, TAURI_JS, "android")).toEqual([NODE, TAURI_JS, "android", "dev"]);
  });
});

describe("iconArgv", () => {
  it("builds the icon regen argv", () => {
    expect(iconArgv(NODE, TAURI_JS, "assets/icon.png")).toEqual([
      NODE,
      TAURI_JS,
      "icon",
      "assets/icon.png"
    ]);
  });
});

describe("mobileInitArgv", () => {
  it("builds ios init", () => {
    expect(mobileInitArgv(NODE, TAURI_JS, "ios")).toEqual([NODE, TAURI_JS, "ios", "init", "--ci"]);
  });

  it("builds android init", () => {
    expect(mobileInitArgv(NODE, TAURI_JS, "android")).toEqual([
      NODE,
      TAURI_JS,
      "android",
      "init",
      "--ci"
    ]);
  });
});

describe("infoArgv", () => {
  it("builds the CLI presence/version probe argv", () => {
    expect(infoArgv(NODE, TAURI_JS)).toEqual([NODE, TAURI_JS, "info"]);
  });
});
