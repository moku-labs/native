/**
 * Shared fixtures for the mobile sub-domain tests: the runner pair, the Gradle signing
 * block, and the generated iOS files Tauri bakes its detected runner into.
 */

// Env-var NAME references, never secrets (the SigningConfig invariant).
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- an env-var *name*, never a secret
export const STORE_PASSWORD_ENV = "KS_PASSWORD";
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- an env-var *name*, never a secret
export const KEY_PASSWORD_ENV = "KS_KEY_PASSWORD";

/** Absolute paths carrying spaces, so quoting is proven by every test that uses them. */
export const RUNNER = {
  nodePath: "/opt/node v20/bin/node",
  tauriJsPath: "/repo/node modules/@tauri-apps/cli/tauri.js"
};

/** The signing config the fixtures' SIGNING_BLOCK renders from. */
export const SIGNING = {
  keystorePath: "release.jks",
  keyAlias: "release",
  keystorePasswordEnv: STORE_PASSWORD_ENV
};

/** The exact block `applySigningBlock` writes for {@link SIGNING}. */
export const SIGNING_BLOCK = [
  "// MOKU-SIGNING-START",
  "android {",
  "  signingConfigs {",
  '    maybeCreate("release").apply {',
  '      storeFile = file("release.jks")',
  '      keyAlias = "release"',
  `      storePassword = System.getenv("${STORE_PASSWORD_ENV}")`,
  `      keyPassword = System.getenv("${STORE_PASSWORD_ENV}")`,
  "    }",
  "  }",
  "  buildTypes {",
  '    getByName("release") {',
  '      signingConfig = signingConfigs.getByName("release")',
  "    }",
  "  }",
  "}",
  "// MOKU-SIGNING-END"
].join("\n");

export const IOS_VERB = "ios xcode-script";
export const ANDROID_VERB = "android android-studio-script";

/** The runners Tauri bakes in, depending on how the CLI was started (bun, npm, cargo, …). */
export const DETECTED_RUNNERS = [
  "node tauri",
  "bun tauri",
  "npm run tauri --",
  "yarn tauri",
  "pnpm tauri",
  "cargo tauri"
];

/** {@link RUNNER} as a YAML scalar. */
export const YML_RUNNER = '"/opt/node v20/bin/node" "/repo/node modules/@tauri-apps/cli/tauri.js"';

/** {@link RUNNER} inside a source string literal (pbxproj, Kotlin, Gradle). */
export const LITERAL_RUNNER = String.raw`\"/opt/node v20/bin/node\" \"/repo/node modules/@tauri-apps/cli/tauri.js\"`;

export const ymlLine = (runner: string) =>
  `        - script: ${runner} ios xcode-script -v --platform $PLATFORM_DISPLAY_NAME`;

export const pbxprojLine = (runner: string) =>
  `\t\tshellScript = "${runner} ios xcode-script -v --platform $PLATFORM_DISPLAY_NAME";`;

export const projectYmlFor = (runner: string) =>
  [
    "targets:",
    "  MyApp_iOS:",
    "    scheme:",
    "      preActions:",
    ymlLine(runner),
    "          name: Build Rust Code",
    ""
  ].join("\n");

export const pbxprojFor = (runner: string) =>
  [
    "/* Begin PBXShellScriptBuildPhase section */",
    pbxprojLine(runner),
    "/* End PBXShellScriptBuildPhase section */",
    ""
  ].join("\n");
