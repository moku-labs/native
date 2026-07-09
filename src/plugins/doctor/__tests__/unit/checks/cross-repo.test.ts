import { describe, expect, it } from "vitest";
import { crossRepoCorsCheck, crossRepoDeepLinkCheck } from "../../../checks/cross-repo";
import { baseGlobalConfig, createCheckInput } from "./fixtures";

describe("crossRepoCorsCheck", () => {
  it("always applies at host scope", () => {
    expect(crossRepoCorsCheck.appliesTo("host", createCheckInput().global)).toBe(true);
  });

  it("does not apply to a real target", () => {
    expect(crossRepoCorsCheck.appliesTo("macos", createCheckInput().global)).toBe(false);
  });

  it("always warns and names both Tauri webview origins", async () => {
    const result = await crossRepoCorsCheck.run(createCheckInput());

    expect(result.status).toBe("warn");
    expect(result.message).toContain("tauri://localhost");
    expect(result.message).toContain("http://tauri.localhost");
  });
});

describe("crossRepoDeepLinkCheck", () => {
  it("does not apply when deep-link is not composed", () => {
    expect(crossRepoDeepLinkCheck.appliesTo("host", baseGlobalConfig)).toBe(false);
  });

  it("applies only when deep-link is composed, at host scope", () => {
    const global = { ...baseGlobalConfig, system: [{ name: "deep-link" }] };

    expect(crossRepoDeepLinkCheck.appliesTo("host", global)).toBe(true);
    expect(crossRepoDeepLinkCheck.appliesTo("macos", global)).toBe(false);
  });

  it("warns and names the .well-known filenames + the D-011 deferral", async () => {
    const global = { ...baseGlobalConfig, system: [{ name: "deep-link" }] };

    const result = await crossRepoDeepLinkCheck.run(createCheckInput({ global }));

    expect(result.status).toBe("warn");
    expect(result.message).toContain("apple-app-site-association");
    expect(result.message).toContain("assetlinks.json");
  });
});
