import { describe, expect, it, vi } from "vitest";
import { iosToolsCheck } from "../../../checks/ios-tools";
import type { ProbeFn } from "../../../types";
import { createCheckInput } from "./fixtures";

/** Real `rustup target list --installed` output shape — one triple per line. */
const IOS_TRIPLES = "aarch64-apple-darwin\naarch64-apple-ios\naarch64-apple-ios-sim\n";

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

/**
 * Builds a probe fake: every command succeeds except those listed in `missing`, and
 * rustup answers with `triples`.
 *
 * @param opts - Which binaries are absent and which rust triples are installed.
 * @param opts.missing - Commands whose probe reports a non-zero exit.
 * @param opts.triples - The `rustup target list --installed` stdout.
 * @returns The probe fake.
 */
function createProbe(opts: { missing?: readonly string[]; triples?: string } = {}): ProbeFn {
  return vi.fn(async (cmd: string) => {
    if (opts.missing?.includes(cmd)) return { code: 1, stdout: "" };
    if (cmd === "rustup") return { code: 0, stdout: opts.triples ?? IOS_TRIPLES };
    return { code: 0, stdout: "ok" };
  });
}

describe("iosToolsCheck.appliesTo", () => {
  it("applies to ios on a darwin host", () => {
    withPlatform("darwin", () => {
      expect(iosToolsCheck.appliesTo("ios", createCheckInput().global)).toBe(true);
    });
  });

  it("does not apply to ios on a non-darwin host", () => {
    withPlatform("linux", () => {
      expect(iosToolsCheck.appliesTo("ios", createCheckInput().global)).toBe(false);
    });
  });

  it("does not apply to other scopes even on darwin", () => {
    withPlatform("darwin", () => {
      expect(iosToolsCheck.appliesTo("macos", createCheckInput().global)).toBe(false);
      expect(iosToolsCheck.appliesTo("host", createCheckInput().global)).toBe(false);
    });
  });
});

describe("iosToolsCheck.run", () => {
  it("passes when xcodegen, pod and both rust targets are present", async () => {
    const probe = createProbe();

    const result = await iosToolsCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("pass");
    expect(result.id).toBe("ios-tools");
    expect(result.target).toBe("ios");
    expect(probe).toHaveBeenCalledWith("rustup", ["target", "list", "--installed"]);
  });

  it("fails with a brew fix-it when xcodegen is missing", async () => {
    const probe = createProbe({ missing: ["xcodegen"] });

    const result = await iosToolsCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("xcodegen");
    expect(result.fixIt).toContain("brew install xcodegen");
  });

  it("fails with a cocoapods fix-it when pod is missing", async () => {
    const probe = createProbe({ missing: ["pod"] });

    const result = await iosToolsCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("pod");
    expect(result.fixIt).toContain("brew install cocoapods");
  });

  it("fails naming only the missing rust target, with its rustup add command", async () => {
    const probe = createProbe({ triples: "aarch64-apple-darwin\naarch64-apple-ios\n" });

    const result = await iosToolsCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("aarch64-apple-ios-sim");
    expect(result.fixIt).toContain("rustup target add aarch64-apple-ios-sim");
  });

  it("reports every missing piece in one result", async () => {
    const probe = createProbe({ missing: ["xcodegen", "pod", "rustup"] });

    const result = await iosToolsCheck.run(createCheckInput({ target: "ios", probe }));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("xcodegen");
    expect(result.message).toContain("pod");
    expect(result.message).toContain("aarch64-apple-ios");
    expect(result.message.startsWith("[native]")).toBe(true);
  });
});
