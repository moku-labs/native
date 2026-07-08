import { describe, expect, it } from "vitest";

import { generateTauriConf } from "../../../generators/tauri-conf";
import { generatorInputFor } from "./fixtures";

describe("generateTauriConf", () => {
  it("writes a single src-tauri/tauri.conf.json artifact", () => {
    const artifacts = generateTauriConf(generatorInputFor("macos"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe("src-tauri/tauri.conf.json");
  });

  it("carries app identity and web build/dev wiring", () => {
    const [artifact] = generateTauriConf(generatorInputFor("macos"));
    const conf = JSON.parse(artifact?.content ?? "{}");

    expect(conf.productName).toBe("My Cool App");
    expect(conf.identifier).toBe("com.example.mycoolapp");
    expect(conf.build).toEqual({
      beforeDevCommand: "bun run dev",
      beforeBuildCommand: "bun run build",
      devUrl: "http://localhost:5173",
      frontendDist: "dist"
    });
  });

  it("carries a plugins.<name> block per resolved capability, deep-link scheme included", () => {
    const [artifact] = generateTauriConf(generatorInputFor("macos"));
    const conf = JSON.parse(artifact?.content ?? "{}");

    expect(conf.plugins.store).toEqual({});
    expect(conf.plugins.tray).toEqual({});
    expect(conf.plugins["deep-link"]).toEqual({ schemes: ["mycoolapp"] });
  });

  it("omits tray's plugins block on a mobile target (platform-filtered upstream)", () => {
    const [artifact] = generateTauriConf(generatorInputFor("ios"));
    const conf = JSON.parse(artifact?.content ?? "{}");

    expect(conf.plugins.tray).toBeUndefined();
    expect(conf.plugins["deep-link"]).toEqual({ schemes: ["mycoolapp"] });
  });
});
