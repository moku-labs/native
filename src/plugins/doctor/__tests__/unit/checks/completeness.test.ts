import { describe, expect, it, vi } from "vitest";
import { completenessCheck } from "../../../checks/completeness";
import { createCheckInput } from "./fixtures";

describe("completenessCheck.appliesTo", () => {
  it("applies only to ios and android", () => {
    expect(completenessCheck.appliesTo("ios", createCheckInput().global)).toBe(true);
    expect(completenessCheck.appliesTo("android", createCheckInput().global)).toBe(true);
  });

  it("does not apply to desktop targets or host", () => {
    expect(completenessCheck.appliesTo("macos", createCheckInput().global)).toBe(false);
    expect(completenessCheck.appliesTo("windows", createCheckInput().global)).toBe(false);
    expect(completenessCheck.appliesTo("linux", createCheckInput().global)).toBe(false);
    expect(completenessCheck.appliesTo("host", createCheckInput().global)).toBe(false);
  });
});

describe("completenessCheck.run", () => {
  it("passes with a will-init note when gen/ hasn't been created yet", async () => {
    const project = {
      getRequiredFiles: vi.fn(() => ["a", "b"]),
      getCompleteness: vi.fn(() => ({ status: "not-initialized" as const })),
      getRegistryRows: vi.fn(() => [])
    };

    const result = await completenessCheck.run(createCheckInput({ target: "android", project }));

    expect(result.status).toBe("pass");
    expect(result.message.toLowerCase()).toContain("will init on first build");
  });

  it("fails and names both the missing files and the clean fix-it", async () => {
    const project = {
      getRequiredFiles: vi.fn(() => ["build.gradle.kts", "settings.gradle.kts"]),
      getCompleteness: vi.fn(() => ({
        status: "incomplete" as const,
        missing: ["settings.gradle.kts"]
      })),
      getRegistryRows: vi.fn(() => [])
    };

    const result = await completenessCheck.run(createCheckInput({ target: "android", project }));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("settings.gradle.kts");
    expect(result.fixIt).toBe("native clean --target android");
  });

  it("passes when complete", async () => {
    const project = {
      getRequiredFiles: vi.fn(() => ["a"]),
      getCompleteness: vi.fn(() => ({ status: "complete" as const })),
      getRegistryRows: vi.fn(() => [])
    };

    const result = await completenessCheck.run(createCheckInput({ target: "ios", project }));

    expect(result.status).toBe("pass");
    expect(result.fixIt).toBeUndefined();
  });

  it("calls project.getCompleteness with the target being diagnosed", async () => {
    const completenessFunction = vi.fn(() => ({ status: "complete" as const }));
    const project = {
      getRequiredFiles: vi.fn(() => []),
      getCompleteness: completenessFunction,
      getRegistryRows: vi.fn(() => [])
    };

    await completenessCheck.run(createCheckInput({ target: "ios", project }));

    expect(completenessFunction).toHaveBeenCalledWith({ target: "ios" });
  });

  it("throws when invoked with a non-mobile target (internal misuse)", async () => {
    await expect(completenessCheck.run(createCheckInput({ target: "host" }))).rejects.toThrow();
  });
});
