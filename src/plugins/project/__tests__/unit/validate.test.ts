import { describe, expect, it } from "vitest";

import type { Config } from "../../../../config";
import { validateProjectConfig } from "../../validate";

const VALID: Config = {
  app: { name: "My App", identifier: "com.example.myapp" },
  web: {
    build: "bun run build",
    devCommand: "bun run dev",
    devUrl: "http://localhost:5173",
    dist: "dist"
  },
  system: [{ name: "store" }],
  capabilities: {},
  targets: ["macos"],
  projectDir: ".moku/tauri",
  outDir: "dist-native",
  signing: {}
};

/** Builds a config from the valid baseline with one stanza replaced. */
const config = (patch: Partial<Config>): Config => ({ ...VALID, ...patch });

describe("validateProjectConfig", () => {
  it("accepts a fully configured app", () => {
    expect(() => validateProjectConfig(VALID)).not.toThrow();
  });

  it("rejects an empty app.name with a fix-it", () => {
    expect(() => validateProjectConfig(config({ app: { ...VALID.app, name: "" } }))).toThrow(
      "[native] app.name is required.\n  Set config.app.name to your app's display name."
    );
  });

  it.each([
    "myapp",
    "",
    "com..myapp",
    "1com.example",
    "com.example.my_app"
  ])('rejects "%s" as an app.identifier', identifier => {
    expect(() => validateProjectConfig(config({ app: { ...VALID.app, identifier } }))).toThrow(
      /is not a valid reverse-DNS identifier/
    );
  });

  it("accepts a mixed-case reverse-DNS identifier", () => {
    expect(() =>
      validateProjectConfig(config({ app: { ...VALID.app, identifier: "Com.Example.MyApp" } }))
    ).not.toThrow();
  });

  it.each(["build", "devCommand", "devUrl", "dist"] as const)("rejects a missing web.%s", field => {
    expect(() => validateProjectConfig(config({ web: { ...VALID.web, [field]: "" } }))).toThrow(
      `[native] web.${field} is required.`
    );
  });

  it("rejects a config.system name the registry does not know", () => {
    expect(() => validateProjectConfig(config({ system: [{ name: "telepathy" }] }))).toThrow(
      '[native] Unknown capability "telepathy" in config.system.'
    );
  });

  it("rejects a composed deep-link without its scheme", () => {
    expect(() => validateProjectConfig(config({ system: [{ name: "deep-link" }] }))).toThrow(
      '[native] deep-link is composed in config.system but capabilities["deep-link"].scheme is missing.'
    );
  });

  it("accepts a composed deep-link carrying its scheme", () => {
    expect(() =>
      validateProjectConfig(
        config({
          system: [{ name: "deep-link" }],
          capabilities: { "deep-link": { mode: "scheme", scheme: "myapp" } }
        })
      )
    ).not.toThrow();
  });
});
