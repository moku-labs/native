import { describe, expect, it, vi } from "vitest";
import { rustupCheck } from "../../../checks/rustup";
import { createCheckInput } from "./fixtures";

describe("rustupCheck.appliesTo", () => {
  it("applies to every real packaging target", () => {
    for (const target of ["macos", "windows", "linux", "ios", "android"] as const) {
      expect(rustupCheck.appliesTo(target, createCheckInput().global)).toBe(true);
    }
  });

  it("does not apply to host", () => {
    expect(rustupCheck.appliesTo("host", createCheckInput().global)).toBe(false);
  });
});

describe("rustupCheck.run", () => {
  it("fails and points at rustup.rs when rustup is not on PATH", async () => {
    const probe = vi.fn(async () => ({ code: 1, stdout: "" }));
    const input = createCheckInput({ target: "ios", probe });

    const result = await rustupCheck.run(input);

    expect(result.status).toBe("fail");
    expect(result.target).toBe("ios");
    expect(result.fixIt).toMatch(/rustup\.rs/);
    expect(probe).toHaveBeenCalledWith("rustup", ["target", "list", "--installed"]);
  });

  it("fails and names the missing triple when the required target isn't installed", async () => {
    const probe = vi.fn(async () => ({ code: 0, stdout: "x86_64-apple-darwin\n" }));
    const input = createCheckInput({ target: "ios", probe });

    const result = await rustupCheck.run(input);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("aarch64-apple-ios");
    expect(result.fixIt).toBe("rustup target add aarch64-apple-ios");
  });

  it("passes when the required triple is installed", async () => {
    const probe = vi.fn(async () => ({
      code: 0,
      stdout: "aarch64-apple-ios\nx86_64-apple-darwin\n"
    }));
    const input = createCheckInput({ target: "ios", probe });

    const result = await rustupCheck.run(input);

    expect(result.status).toBe("pass");
    expect(result.fixIt).toBeUndefined();
  });

  it("resolves the required triple per target", async () => {
    const probe = vi.fn(async () => ({ code: 0, stdout: "x86_64-pc-windows-msvc\n" }));
    const result = await rustupCheck.run(createCheckInput({ target: "windows", probe }));

    expect(result.status).toBe("pass");
  });

  it("throws when invoked without a real packaging target (internal misuse)", async () => {
    await expect(rustupCheck.run(createCheckInput({ target: "host" }))).rejects.toThrow();
  });
});
