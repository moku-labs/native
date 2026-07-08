import { describe, expect, it } from "vitest";

import { generateCapabilities } from "../../../generators/capabilities";
import { generatorInputFor } from "./fixtures";

describe("generateCapabilities", () => {
  it("writes a single src-tauri/capabilities/default.json artifact", () => {
    const artifacts = generateCapabilities(generatorInputFor("macos"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe("src-tauri/capabilities/default.json");
  });

  it("scopes the platforms field to the target", () => {
    const [artifact] = generateCapabilities(generatorInputFor("android"));
    const doc = JSON.parse(artifact?.content ?? "{}");
    expect(doc.platforms).toEqual(["android"]);
  });

  it("aggregates permissions from every resolved capability, tray excluded on mobile", () => {
    const [artifact] = generateCapabilities(generatorInputFor("ios"));
    const doc = JSON.parse(artifact?.content ?? "{}");

    expect(doc.permissions).toContain("store:default");
    expect(doc.permissions).toContain("deep-link:default");
    expect(doc.permissions).not.toContain("core:tray:default");
  });

  it("includes tray's permission on a desktop target", () => {
    const [artifact] = generateCapabilities(generatorInputFor("macos"));
    const doc = JSON.parse(artifact?.content ?? "{}");
    expect(doc.permissions).toContain("core:tray:default");
  });
});
