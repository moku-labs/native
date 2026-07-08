import { describe, expect, it, vi } from "vitest";
import { resolveNodePath, resolveTauriJsPath } from "../../resolve";

function isUsrLocalBinNode(path: string): boolean {
  return path === "/usr/local/bin/node";
}

function isNvmNodeExe(path: string): boolean {
  return path === String.raw`C:\nvm\node.exe`;
}

describe("resolveNodePath", () => {
  it("returns the explicit override without walking PATH", () => {
    const fileExists = vi.fn(() => false);
    expect(resolveNodePath({ nodePath: "/custom/node", fileExists })).toBe("/custom/node");
    expect(fileExists).not.toHaveBeenCalled();
  });

  it("walks POSIX PATH entries and returns the first match", () => {
    const resolved = resolveNodePath({
      pathEnv: "/usr/bin:/usr/local/bin:/opt/bin",
      platform: "darwin",
      fileExists: isUsrLocalBinNode
    });
    expect(resolved).toBe("/usr/local/bin/node");
  });

  it("walks Windows PATH entries with `;` delimiter and `node.exe`", () => {
    const resolved = resolveNodePath({
      pathEnv: String.raw`C:\other;C:\nvm`,
      platform: "win32",
      fileExists: isNvmNodeExe
    });
    expect(resolved).toBe(String.raw`C:\nvm\node.exe`);
  });

  it("throws a [native] error pointing at native doctor when node is not found", () => {
    expect(() =>
      resolveNodePath({ pathEnv: "/usr/bin", platform: "darwin", fileExists: () => false })
    ).toThrow(/\[native\].*node.*native doctor/s);
  });
});

describe("resolveTauriJsPath", () => {
  it("returns the resolved path from the injected resolver", () => {
    const requireResolve = vi.fn(() => "/proj/node_modules/@tauri-apps/cli/tauri.js");
    expect(resolveTauriJsPath({ requireResolve })).toBe(
      "/proj/node_modules/@tauri-apps/cli/tauri.js"
    );
    expect(requireResolve).toHaveBeenCalledWith("@tauri-apps/cli/tauri.js");
  });

  it("throws a [native] error when resolution fails", () => {
    const requireResolve = vi.fn(() => {
      throw new Error("Cannot find module");
    });
    expect(() => resolveTauriJsPath({ requireResolve })).toThrow(/\[native\].*@tauri-apps\/cli/);
  });
});
