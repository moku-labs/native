import { describe, expect, it, vi } from "vitest";
import { versionsCheck } from "../../../checks/versions";
import { createCheckInput } from "./fixtures";

const storeRow = {
  name: "store" as const,
  npmPackage: "@tauri-apps/plugin-store" as const,
  crate: "tauri-plugin-store" as const,
  crateRange: "^2",
  npmRange: "^2",
  rustInit: "",
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
      requiredFiles: vi.fn(() => []),
      completeness: vi.fn(() => ({ status: "not-applicable" as const })),
      registryRows: vi.fn(() => [storeRow])
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
      requiredFiles: vi.fn(() => []),
      completeness: vi.fn(() => ({ status: "not-applicable" as const })),
      registryRows: vi.fn(() => [storeRow])
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

  it("passes when no composed capability is declared in package.json", async () => {
    const fs = { readFile: vi.fn(async () => JSON.stringify({ dependencies: {} })) };
    const project = {
      requiredFiles: vi.fn(() => []),
      completeness: vi.fn(() => ({ status: "not-applicable" as const })),
      registryRows: vi.fn(() => [storeRow])
    };

    const result = await versionsCheck.run(createCheckInput({ fs, project }));

    expect(result.status).toBe("pass");
  });
});
