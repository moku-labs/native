import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { webScriptCheck } from "../../../checks/web-script";
import { baseGlobalConfig, createCheckInput } from "./fixtures";

describe("webScriptCheck.appliesTo", () => {
  it("applies only to host", () => {
    expect(webScriptCheck.appliesTo("host", createCheckInput().global)).toBe(true);
    expect(webScriptCheck.appliesTo("macos", createCheckInput().global)).toBe(false);
  });
});

describe("webScriptCheck.run", () => {
  it("fails and names both missing scripts", async () => {
    const fs = { readFile: vi.fn(async (_path: string) => JSON.stringify({ scripts: {} })) };

    const result = await webScriptCheck.run(createCheckInput({ fs }));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("web.build");
    expect(result.message).toContain("web.devCommand");
  });

  it("passes when both scripts are present", async () => {
    const fs = {
      readFile: vi.fn(async (_path: string) =>
        JSON.stringify({ scripts: { build: "vite build", dev: "vite" } })
      )
    };

    const result = await webScriptCheck.run(createCheckInput({ fs }));

    expect(result.status).toBe("pass");
  });

  it("resolves the default cwd Tauri will use: the consumer root", async () => {
    const readFile = vi.fn(async (_path: string) =>
      JSON.stringify({ scripts: { build: "x", dev: "y" } })
    );

    await webScriptCheck.run(createCheckInput({ fs: { readFile } }));

    expect(readFile).toHaveBeenCalledWith(path.join(path.resolve("."), "package.json"));
  });

  it("honors a web.cwd override for monorepo layouts", async () => {
    const readFile = vi.fn(async (_path: string) =>
      JSON.stringify({ scripts: { build: "x", dev: "y" } })
    );
    const global = { ...baseGlobalConfig, web: { ...baseGlobalConfig.web, cwd: "apps/web" } };

    await webScriptCheck.run(createCheckInput({ fs: { readFile }, global }));

    const [calledPath] = readFile.mock.calls[0] ?? [""];
    expect(calledPath.endsWith(path.join("apps", "web", "package.json"))).toBe(true);
  });

  it("fails (not throws) when package.json cannot be read", async () => {
    const fs = {
      readFile: vi.fn(async (_path: string) => {
        throw new Error("ENOENT");
      })
    };

    const result = await webScriptCheck.run(createCheckInput({ fs }));

    expect(result.status).toBe("fail");
  });

  it("documents necessary-not-sufficient — never executes the script", async () => {
    const fs = {
      readFile: vi.fn(async (_path: string) =>
        JSON.stringify({ scripts: { build: "x", dev: "y" } })
      )
    };

    const result = await webScriptCheck.run(createCheckInput({ fs }));

    expect(result.message.toLowerCase()).toContain("not executed");
  });
});
