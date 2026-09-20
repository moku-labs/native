/* eslint-disable sonarjs/no-hardcoded-passwords -- every value below is an env-var NAME the
   validator must accept or reject (the SigningConfig invariant), never a password. */
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
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

  it.each([
    "my app",
    "1myapp",
    'myapp"',
    "my/app"
  ])('rejects "%s" as a deep-link scheme', scheme => {
    expect(() =>
      validateProjectConfig(
        config({
          system: [{ name: "deep-link" }],
          capabilities: { "deep-link": { mode: "scheme", scheme } }
        })
      )
    ).toThrow("is not a valid URL scheme");
  });
});

describe("validateProjectConfig — app version fields", () => {
  it.each([
    "1.0.0",
    "0.0.1",
    "1.2.3-beta.1",
    "1.2.3+build.5"
  ])('accepts "%s" as an app.version', version => {
    expect(() => validateProjectConfig(config({ app: { ...VALID.app, version } }))).not.toThrow();
  });

  it.each(["1.0", "v1.0.0", '1.0.0" evil', "latest"])('rejects "%s" as an app.version', version => {
    expect(() => validateProjectConfig(config({ app: { ...VALID.app, version } }))).toThrow(
      "is not a valid semantic version"
    );
  });

  it("accepts a plain build number", () => {
    expect(() =>
      validateProjectConfig(config({ app: { ...VALID.app, buildNumber: "1.0.42" } }))
    ).not.toThrow();
  });

  it.each(["42 43", '42"', "42\n43"])('rejects "%s" as an app.buildNumber', buildNumber => {
    expect(() => validateProjectConfig(config({ app: { ...VALID.app, buildNumber } }))).toThrow(
      "is not a valid build number"
    );
  });
});

describe("validateProjectConfig — signing env-var names", () => {
  it("accepts conventional env-var names", () => {
    expect(() =>
      validateProjectConfig(
        config({
          signing: {
            android: {
              keystorePasswordEnv: "ANDROID_KEYSTORE_PASSWORD",
              keyPasswordEnv: "ANDROID_KEY_PASSWORD"
            }
          }
        })
      )
    ).not.toThrow();
  });

  it.each([
    [
      "a keystore password env name that closes the Kotlin literal",
      { keystorePasswordEnv: 'P") + evil("' }
    ],
    ["a key password env name carrying a space", { keyPasswordEnv: "MY PASSWORD" }],
    ["an env name starting with a digit", { keystorePasswordEnv: "1PASSWORD" }]
  ])("rejects %s", (_label, android) => {
    expect(() => validateProjectConfig(config({ signing: { android } }))).toThrow(
      "is not a valid environment variable name"
    );
  });
});

describe("validateProjectConfig — derived directory containment", () => {
  it("accepts the default relative directories", () => {
    expect(() =>
      validateProjectConfig(config({ projectDir: ".moku/tauri", outDir: "dist-native" }))
    ).not.toThrow();
  });

  it("accepts absolute directories under the temp root (mkdtemp workspaces)", () => {
    expect(() =>
      validateProjectConfig(
        config({
          projectDir: path.join(tmpdir(), "moku-native-fixture", ".moku", "tauri"),
          outDir: path.join(tmpdir(), "moku-native-fixture", "dist-native")
        })
      )
    ).not.toThrow();
  });

  it.each([
    ["a personal directory as projectDir", { projectDir: path.join(homedir(), "Documents") }],
    ["the home directory as projectDir", { projectDir: homedir() }],
    ["a filesystem root as projectDir", { projectDir: path.join(path.sep, "..") }],
    ["the home directory as outDir", { outDir: homedir() }],
    ["an ancestor of the home directory as outDir", { outDir: path.dirname(homedir()) }],
    ["a filesystem root as outDir", { outDir: path.join(path.sep, "..") }],
    ["an ancestor of the working directory as outDir", { outDir: path.dirname(process.cwd()) }]
  ])("rejects %s", (_label, patch) => {
    expect(() => validateProjectConfig(config(patch))).toThrow(
      /^\[native] config\.(projectDir|outDir) /
    );
  });

  it("accepts an outDir outside the project — a CI cache mount is never recursively cleaned", () => {
    expect(() =>
      validateProjectConfig(config({ outDir: path.join(homedir(), "Library", "Caches", "moku") }))
    ).not.toThrow();
  });

  it("names the fix in the projectDir error's second line", () => {
    expect(() => validateProjectConfig(config({ projectDir: homedir() }))).toThrow(
      'Set config.projectDir to a path inside the project, such as ".moku/tauri".'
    );
  });

  it("names the fix in the outDir error's second line", () => {
    expect(() => validateProjectConfig(config({ outDir: homedir() }))).toThrow(
      'Set config.outDir to a dedicated delivery directory such as "dist-native".'
    );
  });
});
