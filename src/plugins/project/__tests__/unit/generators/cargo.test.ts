import { describe, expect, it } from "vitest";

import { generateCargo, sanitizePackageName } from "../../../generators/cargo";
import { resolve } from "../../../registry";
import { generatorInputComposing, generatorInputFor } from "./fixtures";

/** The iOS-only dependency table every generated Cargo.toml ends with. */
const IOS_TARGET_TABLE = [`[target.'cfg(target_os = "ios")'.dependencies]`, 'objc2 = "0.6"'].join(
  "\n"
);

/** The generated Cargo.toml for an explicit capability composition. */
const cargoFor = (...args: Parameters<typeof generatorInputComposing>) =>
  generateCargo(generatorInputComposing(...args))[0]?.content ?? "";

/** The plain `[dependencies]` table of a Cargo.toml, up to the next table header. */
const dependenciesTable = (toml: string) =>
  toml.slice(toml.indexOf("[dependencies]"), toml.indexOf("[target."));

describe("sanitizePackageName", () => {
  it("lowercases and hyphenates a display name", () => {
    expect(sanitizePackageName("My Cool App!")).toBe("my-cool-app");
  });

  it("falls back for an empty name", () => {
    expect(sanitizePackageName("")).toBe("moku-native-app");
  });

  it("prefixes a numeric-leading slug so it starts with a letter", () => {
    expect(sanitizePackageName("2Fast")).toBe("app-2fast");
  });
});

describe("generateCargo", () => {
  it("writes a single src-tauri/Cargo.toml artifact", () => {
    const artifacts = generateCargo(generatorInputFor("macos"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe("src-tauri/Cargo.toml");
  });

  it("names the package from the sanitized app name, lib name underscored", () => {
    const [artifact] = generateCargo(generatorInputFor("macos"));
    expect(artifact?.content).toContain('name = "my-cool-app"');
    expect(artifact?.content).toContain('name = "my_cool_app_lib"');
  });

  it("pins one crate dependency per capability that carries a crate", () => {
    const [artifact] = generateCargo(generatorInputFor("macos"));
    expect(artifact?.content).toContain('tauri-plugin-store = "^2"');
    expect(artifact?.content).toContain('tauri-plugin-deep-link = "^2"');
  });

  it("does not pin a crate for tray (a core Tauri cargo feature, not a plugin)", () => {
    const [artifact] = generateCargo(generatorInputFor("macos"));
    expect(artifact?.content).not.toContain("tauri-plugin-tray");
  });

  it("enables tray's cargo feature on the tauri dependency", () => {
    const [artifact] = generateCargo(generatorInputFor("macos"));
    expect(artifact?.content).toContain('tauri = { version = "2.12", features = ["tray-icon"] }');
  });

  it("emits an empty feature list when no capability contributes a cargo feature", () => {
    const [artifact] = generateCargo(generatorInputFor("ios"));
    expect(artifact?.content).toContain('tauri = { version = "2.12", features = [] }');
  });

  it("raises only the tauri floor to 2.12 — tauri-build keeps its own 2.x line", () => {
    const toml = cargoFor("macos", []);
    expect(toml).toContain('tauri = { version = "2.12", features = [] }');
    expect(toml).toContain('tauri-build = { version = "2", features = [] }');
  });

  it.each([
    "macos",
    "windows",
    "linux",
    "ios",
    "android"
  ] as const)("ends with the iOS-only objc2 table on %s", target => {
    const tail = `\n\n${IOS_TARGET_TABLE}\n`;
    expect(cargoFor(target, []).slice(-tail.length)).toBe(tail);
  });

  it("keeps objc2 out of the plain [dependencies] table", () => {
    const toml = cargoFor("ios", [resolve("store")]);
    expect(dependenciesTable(toml)).not.toContain("objc2");
    expect(toml.match(/objc2/g)).toHaveLength(1);
  });

  it("pins the haptics crate on its 2.x line", () => {
    expect(cargoFor("ios", [resolve("haptics")])).toContain('tauri-plugin-haptics = "^2"');
  });

  it("adds no dependency line for back (core permissions only)", () => {
    expect(dependenciesTable(cargoFor("android", [resolve("back")]))).toBe(
      [
        "[dependencies]",
        'tauri = { version = "2.12", features = [] }',
        'serde = { version = "1", features = ["derive"] }',
        'serde_json = "1"',
        "",
        ""
      ].join("\n")
    );
  });

  it("writes the exact Cargo.toml for a composed mobile app", () => {
    expect(cargoFor("ios", [resolve("store"), resolve("haptics")])).toBe(
      [
        "[package]",
        'name = "my-cool-app"',
        'version = "1.2.3"',
        'edition = "2021"',
        "",
        "[lib]",
        'name = "my_cool_app_lib"',
        'crate-type = ["staticlib", "cdylib", "rlib"]',
        "",
        "[build-dependencies]",
        'tauri-build = { version = "2", features = [] }',
        "",
        "[dependencies]",
        'tauri = { version = "2.12", features = [] }',
        'serde = { version = "1", features = ["derive"] }',
        'serde_json = "1"',
        'tauri-plugin-haptics = "^2"',
        'tauri-plugin-store = "^2"',
        "",
        IOS_TARGET_TABLE,
        ""
      ].join("\n")
    );
  });
});
