import { describe, expect, it } from "vitest";

import type { BuildProfile } from "../../../../../config";
import { generateShell } from "../../../generators/shell";
import { resolve } from "../../../registry";
import { generatorInputComposing } from "./fixtures";

/** Where the shell crate lives, relative to `projectDir`. */
const CRATE = "plugins/moku-shell";

/** One file of the shell crate generated for android with the shell composed. */
const shellFile = (profile: BuildProfile, relative: string) =>
  generateShell(generatorInputComposing("android", [resolve("shell")]), profile).find(
    artifact => artifact.path === `${CRATE}/${relative}`
  )?.content ?? "";

/** Every double-quoted string inside the `[ … ]` assigned to `anchor` (`anchor … = [ … ]`). */
const quotedListAfter = (text: string, anchor: string) => {
  const start = text.indexOf("[", text.indexOf("=", text.indexOf(anchor)));
  const list = text.slice(start, text.indexOf("]", start));
  return [...list.matchAll(/"([^"]+)"/g)].map(match => match[1]);
};

describe("generateShell", () => {
  it("generates nothing under plugins/ when shell is not composed (backward compatibility)", () => {
    const input = generatorInputComposing("android", [resolve("store"), resolve("haptics")]);

    expect(generateShell(input, "debug")).toEqual([]);
  });

  it("Cargo.toml carries `links` (bug: the CLI never finds the plugin's Android library)", () => {
    expect(shellFile("store", "Cargo.toml")).toContain('links = "tauri-plugin-moku-shell"');
  });

  it("MokuShellProfile.DEBUG follows the profile (bug: WebView debugging left on in a store app)", () => {
    const debugProfile = "android/src/main/java/app/moku/shell/MokuShellProfile.kt";

    expect(shellFile("debug", debugProfile)).toContain("const val DEBUG = true");
    expect(shellFile("store", debugProfile)).toContain("const val DEBUG = false");
  });

  it("default.toml grants exactly the six commands build.rs declares (bug: share or info denied at runtime)", () => {
    const commands = quotedListAfter(shellFile("store", "build.rs"), "COMMANDS");
    const granted = quotedListAfter(shellFile("store", "permissions/default.toml"), "permissions");

    expect(commands).toEqual(["set_frame_rate", "thermal", "insets", "log", "share", "info"]);
    expect(granted).toEqual(commands.map(command => `allow-${command?.replaceAll("_", "-")}`));
  });
});
