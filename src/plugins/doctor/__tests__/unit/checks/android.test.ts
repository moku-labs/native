import { describe, expect, it, vi } from "vitest";
import { androidCheck } from "../../../checks/android";
import { createCheckInput, createEnv } from "./fixtures";

describe("androidCheck.appliesTo", () => {
  it("applies only to android", () => {
    expect(androidCheck.appliesTo("android", createCheckInput().global)).toBe(true);
    expect(androidCheck.appliesTo("ios", createCheckInput().global)).toBe(false);
    expect(androidCheck.appliesTo("host", createCheckInput().global)).toBe(false);
  });
});

describe("androidCheck.run", () => {
  it("fails and lists every missing piece", async () => {
    const probe = vi.fn(async () => ({ code: 1, stdout: "" }));
    const input = createCheckInput({ target: "android", env: createEnv(), probe });

    const result = await androidCheck.run(input);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("ANDROID_HOME");
    expect(result.message).toContain("ANDROID_NDK_HOME");
    expect(result.message.toLowerCase()).toContain("jdk");
  });

  it("passes when ANDROID_HOME, ANDROID_NDK_HOME, and java are all present", async () => {
    const env = createEnv({ ANDROID_HOME: "/sdk", ANDROID_NDK_HOME: "/ndk" });
    const probe = vi.fn(async () => ({ code: 0, stdout: "openjdk version 21" }));

    const result = await androidCheck.run(createCheckInput({ target: "android", env, probe }));

    expect(result.status).toBe("pass");
  });

  it("accepts ANDROID_SDK_ROOT as an alternative to ANDROID_HOME", async () => {
    const env = createEnv({ ANDROID_SDK_ROOT: "/sdk", ANDROID_NDK_HOME: "/ndk" });
    const probe = vi.fn(async () => ({ code: 0, stdout: "openjdk version 21" }));

    const result = await androidCheck.run(createCheckInput({ target: "android", env, probe }));

    expect(result.status).toBe("pass");
  });

  it("fails when only the NDK is missing", async () => {
    const env = createEnv({ ANDROID_HOME: "/sdk" });
    const probe = vi.fn(async () => ({ code: 0, stdout: "openjdk version 21" }));

    const result = await androidCheck.run(createCheckInput({ target: "android", env, probe }));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("ANDROID_NDK_HOME");
    expect(result.message).not.toContain("ANDROID_HOME (or");
  });
});
