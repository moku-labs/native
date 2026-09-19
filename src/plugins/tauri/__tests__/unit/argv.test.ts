import { describe, expect, it } from "vitest";
import { buildArgv, devArgv, iconArgv, infoArgv, mobileInitArgv } from "../../argv";
import type { BuildArgvOptions } from "../../types";

const NODE = "/usr/bin/node";
const TAURI_JS = "/proj/node_modules/@tauri-apps/cli/tauri.js";

/** One row of the buildArgv option matrix: options (+ host arch) in, argv tail out. */
type BuildCase = {
  name: string;
  opts: BuildArgvOptions;
  arch?: NodeJS.Architecture;
  tail: readonly string[];
};

// Full option matrix — every combination of target x simulator x exportMethod x aab.
const BUILD_CASES: readonly BuildCase[] = [
  { name: "macos plain", opts: { target: "macos" }, tail: ["build", "--ci"] },
  { name: "windows plain", opts: { target: "windows" }, tail: ["build", "--ci"] },
  { name: "linux plain", opts: { target: "linux" }, tail: ["build", "--ci"] },
  {
    name: "macos ignores mobile-only options",
    opts: { target: "macos", simulator: true, aab: true, exportMethod: "release-testing" },
    tail: ["build", "--ci"]
  },
  { name: "ios plain", opts: { target: "ios" }, tail: ["ios", "build", "--ci"] },
  {
    name: "ios simulator on arm64",
    opts: { target: "ios", simulator: true },
    arch: "arm64",
    tail: ["ios", "build", "--ci", "--target", "aarch64-sim"]
  },
  {
    name: "ios simulator on x64",
    opts: { target: "ios", simulator: true },
    arch: "x64",
    tail: ["ios", "build", "--ci", "--target", "x86_64"]
  },
  {
    name: "ios simulator: false falls back to the device verb",
    opts: { target: "ios", simulator: false },
    tail: ["ios", "build", "--ci"]
  },
  {
    name: "ios exportMethod app-store-connect",
    opts: { target: "ios", exportMethod: "app-store-connect" },
    tail: ["ios", "build", "--ci", "--export-method", "app-store-connect"]
  },
  {
    name: "ios exportMethod release-testing",
    opts: { target: "ios", exportMethod: "release-testing" },
    tail: ["ios", "build", "--ci", "--export-method", "release-testing"]
  },
  {
    name: "ios exportMethod debugging",
    opts: { target: "ios", exportMethod: "debugging" },
    tail: ["ios", "build", "--ci", "--export-method", "debugging"]
  },
  {
    name: "ios simulator suppresses --export-method (a simulator build is never exported)",
    opts: { target: "ios", simulator: true, exportMethod: "app-store-connect" },
    arch: "arm64",
    tail: ["ios", "build", "--ci", "--target", "aarch64-sim"]
  },
  {
    name: "ios ignores aab",
    opts: { target: "ios", aab: true },
    tail: ["ios", "build", "--ci"]
  },
  {
    name: "android plain",
    opts: { target: "android" },
    tail: ["android", "build", "--ci", "--apk"]
  },
  {
    name: "android aab",
    opts: { target: "android", aab: true },
    tail: ["android", "build", "--ci", "--aab"]
  },
  {
    name: "android aab: false",
    opts: { target: "android", aab: false },
    tail: ["android", "build", "--ci", "--apk"]
  },
  {
    name: "android ignores ios-only options",
    opts: { target: "android", simulator: true, exportMethod: "debugging" },
    tail: ["android", "build", "--ci", "--apk"]
  }
];

describe("buildArgv", () => {
  it.each(BUILD_CASES)("$name", ({ opts, arch, tail }) => {
    expect(buildArgv(NODE, TAURI_JS, opts, arch)).toEqual([NODE, TAURI_JS, ...tail]);
  });

  it("defaults the simulator arch to the host arch", () => {
    const expected = process.arch === "x64" ? "x86_64" : "aarch64-sim";
    expect(buildArgv(NODE, TAURI_JS, { target: "ios", simulator: true })).toEqual([
      NODE,
      TAURI_JS,
      "ios",
      "build",
      "--ci",
      "--target",
      expected
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
  it("writes the icon set into the generated project's src-tauri/icons", () => {
    expect(
      iconArgv(NODE, TAURI_JS, "assets/icon.png", "/proj/.moku/tauri/src-tauri/icons")
    ).toEqual([
      NODE,
      TAURI_JS,
      "icon",
      "assets/icon.png",
      "--output",
      "/proj/.moku/tauri/src-tauri/icons"
    ]);
  });

  it("keeps an output directory containing spaces as one argv entry", () => {
    expect(iconArgv(NODE, TAURI_JS, "icon.png", "/My Apps/proj/src-tauri/icons").at(-1)).toBe(
      "/My Apps/proj/src-tauri/icons"
    );
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
