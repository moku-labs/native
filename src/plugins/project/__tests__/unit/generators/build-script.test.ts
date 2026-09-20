import { describe, expect, it } from "vitest";

import { generateBuildScript } from "../../../generators/build-script";

describe("generateBuildScript", () => {
  it("writes a single src-tauri/build.rs artifact", () => {
    const artifacts = generateBuildScript();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe("src-tauri/build.rs");
  });

  it("emits the exact tauri_build::build() entry point", () => {
    const [artifact] = generateBuildScript();
    expect(artifact?.content).toBe("fn main() {\n  tauri_build::build()\n}\n");
  });
});
