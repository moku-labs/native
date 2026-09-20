import { describe, expect, it } from "vitest";

import { generateCargo, sanitizePackageName } from "../../../generators/cargo";
import { generatorInputFor } from "./fixtures";

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
    expect(artifact?.content).toContain('tauri = { version = "2", features = ["tray-icon"] }');
  });

  it("emits an empty feature list when no capability contributes a cargo feature", () => {
    const [artifact] = generateCargo(generatorInputFor("ios"));
    expect(artifact?.content).toContain('tauri = { version = "2", features = [] }');
  });
});
