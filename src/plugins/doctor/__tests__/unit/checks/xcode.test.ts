import { afterEach, describe, expect, it, vi } from "vitest";
import { xcodeCheck } from "../../../checks/xcode";
import { createCheckInput } from "./fixtures";

/** Temporarily overrides `process.platform` for the duration of `fn`. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

describe("xcodeCheck.appliesTo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies to ios on a darwin host", () => {
    withPlatform("darwin", () => {
      expect(xcodeCheck.appliesTo("ios", createCheckInput().global)).toBe(true);
    });
  });

  it("does not apply to other targets even on darwin", () => {
    withPlatform("darwin", () => {
      expect(xcodeCheck.appliesTo("android", createCheckInput().global)).toBe(false);
      expect(xcodeCheck.appliesTo("macos", createCheckInput().global)).toBe(false);
      expect(xcodeCheck.appliesTo("host", createCheckInput().global)).toBe(false);
    });
  });

  it("does not apply to ios on a non-darwin host", () => {
    withPlatform("linux", () => {
      expect(xcodeCheck.appliesTo("ios", createCheckInput().global)).toBe(false);
    });
  });
});

describe("xcodeCheck.run", () => {
  it("fails when xcodebuild is not found", async () => {
    const probe = vi.fn(async (cmd: string) =>
      cmd === "xcodebuild" ? { code: 1, stdout: "" } : { code: 0, stdout: "" }
    );

    const result = await xcodeCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("Xcode");
    expect(probe).toHaveBeenCalledWith("xcodebuild", ["-version"]);
  });

  it("fails when simulators are not queryable", async () => {
    const probe = vi.fn(async (cmd: string) =>
      cmd === "xcodebuild" ? { code: 0, stdout: "Xcode 15.0" } : { code: 1, stdout: "" }
    );

    const result = await xcodeCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("fail");
    expect(result.message.toLowerCase()).toContain("simulator");
    expect(probe).toHaveBeenCalledWith("xcrun", ["simctl", "list", "devices"]);
  });

  it("passes when both xcodebuild and simctl succeed", async () => {
    const probe = vi.fn(async () => ({ code: 0, stdout: "ok" }));

    const result = await xcodeCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("pass");
  });
});
