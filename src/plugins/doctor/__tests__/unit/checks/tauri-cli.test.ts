/* eslint-disable unicorn/no-null -- mirrors tauri.version()'s real `{ cliVersion } | null` contract (D-014). */
import { describe, expect, it, vi } from "vitest";
import { tauriCliCheck } from "../../../checks/tauri-cli";
import { createCheckInput } from "./fixtures";

describe("tauriCliCheck.appliesTo", () => {
  it("applies only to host", () => {
    expect(tauriCliCheck.appliesTo("host", createCheckInput().global)).toBe(true);
    expect(tauriCliCheck.appliesTo("macos", createCheckInput().global)).toBe(false);
  });
});

describe("tauriCliCheck.run", () => {
  it("fails when tauri.version() resolves null", async () => {
    const tauri = {
      version: vi.fn(async (): Promise<{ cliVersion: string } | null> => null)
    };

    const result = await tauriCliCheck.run(createCheckInput({ tauri }));

    expect(result.status).toBe("fail");
    expect(result.target).toBe("host");
  });

  it("passes and reports the detected cli version", async () => {
    const tauri = { version: vi.fn(async () => ({ cliVersion: "2.9.1" })) };

    const result = await tauriCliCheck.run(createCheckInput({ tauri }));

    expect(result.status).toBe("pass");
    expect(result.message).toContain("2.9.1");
  });
});
