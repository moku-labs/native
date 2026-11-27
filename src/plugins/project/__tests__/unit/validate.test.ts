/* eslint-disable sonarjs/no-hardcoded-passwords -- every value below is an env-var NAME the
   validator must accept or reject (the SigningConfig invariant), never a password. */
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import type { Config } from "../../../../config";
import type { LaunchConfig } from "../../../../index";
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

describe("validateProjectConfig — app presentation fields", () => {
  it.each([
    "portrait",
    "landscape",
    "any"
  ] as const)('accepts "%s" as an app.orientation', orientation => {
    expect(() =>
      validateProjectConfig(config({ app: { ...VALID.app, orientation } }))
    ).not.toThrow();
  });

  it("rejects an app.orientation outside the three, with a fix-it", () => {
    // Config arrives as plain JS too, so the closed set is checked at runtime.
    const app = { ...VALID.app, orientation: "sideways" };

    // @ts-expect-error -- "sideways" is not an Orientation; plain-JS callers can still pass it
    expect(() => validateProjectConfig(config({ app }))).toThrow(
      '[native] app.orientation "sideways" is not a valid orientation.\n  Use "portrait", "landscape" or "any".'
    );
  });

  it.each([
    "#10161d",
    "#10161dff",
    "#ABCDEF"
  ])('accepts "%s" as an app.backgroundColor', backgroundColor => {
    expect(() =>
      validateProjectConfig(config({ app: { ...VALID.app, backgroundColor } }))
    ).not.toThrow();
  });

  it.each([
    "10161d",
    "#1016",
    "#10161d0",
    "#10161g",
    "dark"
  ])('rejects "%s" as an app.backgroundColor', backgroundColor => {
    expect(() => validateProjectConfig(config({ app: { ...VALID.app, backgroundColor } }))).toThrow(
      `[native] app.backgroundColor "${backgroundColor}" is not a valid colour.\n  Use a hex colour such as "#10161d".`
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

describe("validateProjectConfig — adaptive icon inset", () => {
  it.each([
    0,
    31,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ])("rejects %s as app.adaptiveIconInset (bug: an inset that hides the icon)", adaptiveIconInset => {
    expect(() =>
      validateProjectConfig(config({ app: { ...VALID.app, adaptiveIconInset } }))
    ).toThrow("[native] app.adaptiveIconInset must be");
  });

  it.each([19.44, 30])("accepts %s as app.adaptiveIconInset", adaptiveIconInset => {
    expect(() =>
      validateProjectConfig(config({ app: { ...VALID.app, adaptiveIconInset } }))
    ).not.toThrow();
  });
});

describe("validateProjectConfig — the iOS fields", () => {
  it.each([
    "16.0",
    "26.0.1"
  ])('accepts "%s" as signing.apple.iosMinimumSystemVersion', iosMinimumSystemVersion => {
    expect(() =>
      validateProjectConfig(config({ signing: { apple: { iosMinimumSystemVersion } } }))
    ).not.toThrow();
  });

  it.each([
    "16",
    "16.0.1.2.3",
    "v16.0",
    '16.0"',
    "16.0\n    evil: true"
  ])("rejects %j as signing.apple.iosMinimumSystemVersion (bug: it lands raw in project.yml and project.pbxproj)", iosMinimumSystemVersion => {
    expect(() =>
      validateProjectConfig(config({ signing: { apple: { iosMinimumSystemVersion } } }))
    ).toThrow(
      `[native] signing.apple.iosMinimumSystemVersion "${iosMinimumSystemVersion}" is not a valid iOS version.\n  Use a version such as "16.0".`
    );
  });

  it("accepts an absolute ios.privacyManifest", () => {
    expect(() =>
      validateProjectConfig(
        config({ ios: { privacyManifest: path.join(tmpdir(), "PrivacyInfo.xcprivacy") } })
      )
    ).not.toThrow();
  });

  it("rejects a relative ios.privacyManifest (bug: it resolves against whichever cwd ran the build)", () => {
    expect(() =>
      validateProjectConfig(config({ ios: { privacyManifest: "PrivacyInfo.xcprivacy" } }))
    ).toThrow(
      '[native] ios.privacyManifest "PrivacyInfo.xcprivacy" must be an absolute path.\n  Resolve it first, such as with path.resolve("PrivacyInfo.xcprivacy").'
    );
  });

  it("accepts every plist shape, nested", () => {
    const infoPlist = {
      ITSAppUsesNonExemptEncryption: false,
      Name: "Demo",
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true, Domains: ["a", { b: "c" }] }
    };

    expect(() => validateProjectConfig(config({ ios: { infoPlist } }))).not.toThrow();
  });

  it.each([
    ["a number", { Version: 1 }, "ios.infoPlist.Version"],
    ["a nested null", JSON.parse('{ "A": { "B": null } }'), "ios.infoPlist.A.B"],
    ["an undefined", { A: undefined }, "ios.infoPlist.A"],
    ["a class instance", { A: new Date(0) }, "ios.infoPlist.A"],
    ["a value inside an array", { A: ["ok", 2] }, "ios.infoPlist.A.1"]
  ])("rejects %s in ios.infoPlist, naming the dotted key (bug: it renders as an empty <dict>)", (_label, infoPlist, key) => {
    // Config arrives as plain JS too, so the type does not protect the generated plist.
    expect(() => validateProjectConfig(config({ ios: { infoPlist } }))).toThrow(
      `[native] ${key} is not a plist value.\n  Use a string, a boolean, an array or a plain object.`
    );
  });
});

describe("validateProjectConfig — app.launch", () => {
  const LAUNCH: LaunchConfig = {
    still: {
      image: "assets/splash/studio.webp",
      frame: { width: 1024, height: 1536 },
      rect: { x: 215, y: 402, width: 600, height: 640 }
    },
    aspect: { min: 4 / 3, max: 21 / 9 }
  };

  /** A config whose app.launch is `launch`, typed or not: plain-JS config can carry anything. */
  const withLaunch = (launch: unknown) =>
    config({ app: { ...VALID.app, launch: launch as LaunchConfig } });

  /** {@link LAUNCH} with its still replaced in part. */
  const withStill = (still: Record<string, unknown>) =>
    withLaunch({ ...LAUNCH, still: { ...LAUNCH.still, ...still } });

  it("accepts the A Memory Missing still, a range below 1, and every optional field at its bound", () => {
    expect(() => validateProjectConfig(withLaunch(LAUNCH))).not.toThrow();
    expect(() =>
      validateProjectConfig(withLaunch({ ...LAUNCH, aspect: { min: 0.4, max: 2.6 } }))
    ).not.toThrow();
    expect(() =>
      validateProjectConfig(
        withLaunch({
          still: {
            ...LAUNCH.still,
            image: "STILL.PNG",
            rect: { x: 0, y: 0, width: 1024, height: 1536 }
          },
          orientation: "landscape",
          holdMaxMs: 60_000
        })
      )
    ).not.toThrow();
  });

  it.each([
    ["app.launch that is not an object", "splash.png", "[native] app.launch must be an object."],
    ["a missing still", { aspect: LAUNCH.aspect }, "[native] app.launch.still must be an object."],
    [
      "a missing still.frame",
      { still: { image: "a.png", rect: LAUNCH.still.rect } },
      "[native] app.launch.still.frame must be an object."
    ],
    [
      "a missing still.rect",
      { still: { image: "a.png", frame: LAUNCH.still.frame } },
      "[native] app.launch.still.rect must be an object."
    ],
    [
      "an aspect that is not an object",
      { ...LAUNCH, aspect: "wide" },
      "[native] app.launch.aspect must be an object."
    ]
  ])("rejects %s, naming it (bug: a TypeError deep in the patch)", (_label, launch, message) => {
    expect(() => validateProjectConfig(withLaunch(launch))).toThrow(message);
  });

  it.each([
    [
      "an empty image",
      { image: "" },
      '[native] app.launch.still.image "" is not a .png or .webp file.'
    ],
    [
      "a .jpg image",
      { image: "a.jpg" },
      '[native] app.launch.still.image "a.jpg" is not a .png or .webp file.'
    ],
    [
      "an image that is a list (bug: path.resolve throws a TypeError later)",
      { image: ["studio.png"] },
      '[native] app.launch.still.image must be a string.\n  Point it at the still picture, such as "assets/splash/studio.webp".'
    ],
    [
      "a zero frame width",
      { frame: { width: 0, height: 1536 } },
      "[native] app.launch.still.frame.width must be a finite number above 0, got 0."
    ],
    [
      "a NaN frame height",
      { frame: { width: 1024, height: Number.NaN } },
      "[native] app.launch.still.frame.height must be a finite number above 0, got NaN."
    ],
    [
      "a zero rect width",
      { rect: { x: 0, y: 0, width: 0, height: 10 } },
      "[native] app.launch.still.rect.width must be a finite number above 0, got 0."
    ],
    [
      "an infinite rect height",
      { rect: { x: 0, y: 0, width: 10, height: Number.POSITIVE_INFINITY } },
      "[native] app.launch.still.rect.height must be a finite number above 0, got Infinity."
    ],
    [
      "a negative rect x",
      { rect: { x: -1, y: 0, width: 10, height: 10 } },
      "[native] app.launch.still.rect.x must be a finite number of 0 or more, got -1."
    ],
    [
      "a NaN rect y",
      { rect: { x: 0, y: Number.NaN, width: 10, height: 10 } },
      "[native] app.launch.still.rect.y must be a finite number of 0 or more, got NaN."
    ],
    [
      "a rect past the frame's right edge",
      { rect: { x: 425, y: 402, width: 600, height: 640 } },
      "[native] app.launch.still.rect reaches past app.launch.still.frame: x + width is 1025, frame.width is 1024."
    ],
    [
      "a rect past the frame's bottom edge",
      { rect: { x: 215, y: 897, width: 600, height: 640 } },
      "[native] app.launch.still.rect reaches past app.launch.still.frame: y + height is 1537, frame.height is 1536."
    ]
  ])("rejects %s (bug: the still is drawn off its canvas or not at all)", (_label, still, message) => {
    expect(() => validateProjectConfig(withStill(still))).toThrow(message);
  });

  it.each([
    ["a min of 0", { min: 0, max: 2 }],
    ["a min that prints as 0.000000f", { min: 0.000_000_5, max: 2 }],
    ["a max below min", { min: 2, max: 1.5 }],
    ["a NaN min", { min: Number.NaN, max: 2 }],
    ["an infinite max", { min: 1, max: Number.POSITIVE_INFINITY }]
  ])("rejects %s as app.launch.aspect (bug: the Kotlin clamp throws or never clamps)", (_label, aspect) => {
    expect(() => validateProjectConfig(withLaunch({ ...LAUNCH, aspect }))).toThrow(
      `[native] app.launch.aspect must have a finite min of at least 0.000001 and a finite max of at least min, got { min: ${String(aspect.min)}, max: ${String(aspect.max)} }.\n  Use the range of the game frame's long side / short side, such as { min: 4 / 3, max: 21 / 9 }.`
    );
  });

  it("rejects an orientation other than portrait or landscape", () => {
    expect(() => validateProjectConfig(withLaunch({ ...LAUNCH, orientation: "any" }))).toThrow(
      '[native] app.launch.orientation "any" is not a valid orientation.\n  Use "portrait" or "landscape", or unset it to follow app.orientation.'
    );
  });

  it('rejects an orientation that is not a string (bug: ["portrait"] passes the pattern and is read as landscape)', () => {
    expect(() =>
      validateProjectConfig(withLaunch({ ...LAUNCH, orientation: ["portrait"] }))
    ).toThrow(
      '[native] app.launch.orientation must be a string.\n  Use "portrait" or "landscape", or unset it to follow app.orientation.'
    );
  });

  it("accepts the smallest aspect bound the Kotlin can print", () => {
    expect(() =>
      validateProjectConfig(withLaunch({ ...LAUNCH, aspect: { min: 0.000_001, max: 2 } }))
    ).not.toThrow();
  });

  it.each([0, 60_001, 1.5, Number.NaN])("rejects %s as app.launch.holdMaxMs", holdMaxMs => {
    expect(() => validateProjectConfig(withLaunch({ ...LAUNCH, holdMaxMs }))).toThrow(
      `[native] app.launch.holdMaxMs must be a whole number above 0 and at most 60000, got ${String(holdMaxMs)}.\n  Use the milliseconds the still may wait for ready(), such as 8000, or unset it for 8000.`
    );
  });
});
