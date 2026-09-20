import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { versionsCheck } from "../../../checks/versions";
import { baseGlobalConfig, createCheckInput } from "./fixtures";

const storeRow = {
  name: "store" as const,
  npmPackage: "@tauri-apps/plugin-store" as const,
  crate: "tauri-plugin-store" as const,
  crateRange: "^2",
  npmRange: "^2",
  rustInit: "",
  cargoFeatures: [],
  permissions: [],
  platforms: [],
  confidence: "high" as const
};

/** The tray row: a cargo-feature-only capability — no npm package, no crate. */
const trayRow = {
  name: "tray" as const,
  cargoFeatures: ["tray-icon"],
  permissions: [],
  platforms: [],
  confidence: "high" as const
};

describe("versionsCheck.appliesTo", () => {
  it("applies only to host", () => {
    expect(versionsCheck.appliesTo("host", createCheckInput().global)).toBe(true);
    expect(versionsCheck.appliesTo("macos", createCheckInput().global)).toBe(false);
  });
});

describe("versionsCheck.run", () => {
  it("warns on a major-version skew between the npm package and the pinned crate range", async () => {
    const fs = {
      readFile: vi.fn(async () =>
        JSON.stringify({ dependencies: { "@tauri-apps/plugin-store": "^3.0.0" } })
      )
    };
    const project = {
      getRequiredFiles: vi.fn(() => []),
      getCompleteness: vi.fn(() => ({ status: "not-applicable" as const })),
      getRegistryRows: vi.fn(() => [storeRow])
    };

    const result = await versionsCheck.run(createCheckInput({ fs, project }));

    expect(result.status).toBe("warn");
    expect(result.message).toContain("@tauri-apps/plugin-store");
  });

  it("passes when the npm major matches the pinned crate range", async () => {
    const fs = {
      readFile: vi.fn(async () =>
        JSON.stringify({ dependencies: { "@tauri-apps/plugin-store": "^2.3.0" } })
      )
    };
    const project = {
      getRequiredFiles: vi.fn(() => []),
      getCompleteness: vi.fn(() => ({ status: "not-applicable" as const })),
      getRegistryRows: vi.fn(() => [storeRow])
    };

    const result = await versionsCheck.run(createCheckInput({ fs, project }));

    expect(result.status).toBe("pass");
  });

  it("never fails when package.json cannot be read", async () => {
    const fs = {
      readFile: vi.fn(async () => {
        throw new Error("ENOENT");
      })
    };

    const result = await versionsCheck.run(createCheckInput({ fs }));

    expect(result.status).not.toBe("fail");
  });

  it("never fails when package.json is not valid JSON", async () => {
    const fs = { readFile: vi.fn(async () => "not json") };

    const result = await versionsCheck.run(createCheckInput({ fs }));

    expect(result.status).not.toBe("fail");
  });

  it("skips a row with no npm package (tray) instead of throwing", async () => {
    const fs = {
      readFile: vi.fn(async () =>
        JSON.stringify({ dependencies: { "@tauri-apps/plugin-store": "^3.0.0" } })
      )
    };
    const project = {
      getRequiredFiles: vi.fn(() => []),
      getCompleteness: vi.fn(() => ({ status: "not-applicable" as const })),
      getRegistryRows: vi.fn(() => [trayRow])
    };

    const result = await versionsCheck.run(createCheckInput({ fs, project }));

    expect(result.status).toBe("pass");
    expect(result.message).not.toContain("tray");
  });

  it("resolves package.json from the configured web.cwd root", async () => {
    const readFile = vi.fn(async () => "{}");
    const global = { ...baseGlobalConfig, web: { ...baseGlobalConfig.web, cwd: "apps/web" } };

    await versionsCheck.run(createCheckInput({ fs: { readFile }, global }));

    expect(readFile).toHaveBeenCalledWith(path.join(path.resolve("apps/web"), "package.json"));
  });

  it("resolves package.json from the process cwd when web.cwd is unset", async () => {
    const readFile = vi.fn(async () => "{}");

    await versionsCheck.run(createCheckInput({ fs: { readFile } }));

    expect(readFile).toHaveBeenCalledWith(path.join(path.resolve("."), "package.json"));
  });

  it("passes when no composed capability is declared in package.json", async () => {
    const fs = { readFile: vi.fn(async () => JSON.stringify({ dependencies: {} })) };
    const project = {
      getRequiredFiles: vi.fn(() => []),
      getCompleteness: vi.fn(() => ({ status: "not-applicable" as const })),
      getRegistryRows: vi.fn(() => [storeRow])
    };

    const result = await versionsCheck.run(createCheckInput({ fs, project }));

    expect(result.status).toBe("pass");
  });
});
