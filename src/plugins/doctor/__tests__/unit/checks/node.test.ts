import { describe, expect, it, vi } from "vitest";
import { nodeCheck } from "../../../checks/node";
import { createCheckInput } from "./fixtures";

describe("nodeCheck.appliesTo", () => {
  it("applies only to host", () => {
    expect(nodeCheck.appliesTo("host", createCheckInput().global)).toBe(true);
    expect(nodeCheck.appliesTo("macos", createCheckInput().global)).toBe(false);
    expect(nodeCheck.appliesTo("ios", createCheckInput().global)).toBe(false);
  });
});

describe("nodeCheck.run", () => {
  it("fails and cites tauri#9939 when node is not found", async () => {
    const probe = vi.fn(async () => ({ code: 1, stdout: "" }));
    const result = await nodeCheck.run(createCheckInput({ probe }));

    expect(result.status).toBe("fail");
    expect(result.target).toBe("host");
    expect(result.message).toContain("9939");
    expect(probe).toHaveBeenCalledWith("node", ["--version"]);
  });

  it("passes and reports the detected version", async () => {
    const probe = vi.fn(async () => ({ code: 0, stdout: "v22.1.0\n" }));
    const result = await nodeCheck.run(createCheckInput({ probe }));

    expect(result.status).toBe("pass");
    expect(result.message).toContain("v22.1.0");
    expect(result.fixIt).toBeUndefined();
  });
});
