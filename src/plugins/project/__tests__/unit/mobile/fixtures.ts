/**
 * Shared fixtures for the mobile sub-domain tests: the runner pair, the Gradle signing
 * block, the generated iOS files Tauri bakes its detected runner into, and the generated
 * Android MainActivity.kt.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * The runners Tauri bakes in when an absolute node drives `tauri ios|android init`: each
 * one path-qualified, so the path sits right after the quote that opens the build phase.
 */
export const PATH_QUALIFIED_RUNNERS = [
  "/opt/homebrew/bin/node tauri",
  "/usr/local/bin/bun tauri",
  "/repo/node_modules/.bin/tauri",
  "/opt/homebrew/bin/npm run tauri --"
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

/** The main activity's attribute lines in the tauri 2.12 Android template, one per line. */
export const TEMPLATE_ACTIVITY_ATTRIBUTES = [
  '            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"',
  '            android:launchMode="singleTask"',
  '            android:label="@string/main_activity_title"',
  '            android:name=".MainActivity"',
  '            android:exported="true">'
];

/** An `android:screenOrientation` attribute line at the template's attribute indentation. */
export const screenOrientationLine = (value: string) =>
  `            android:screenOrientation="${value}"`;

/**
 * `gen/android/app/src/main/AndroidManifest.xml` as `tauri android init` 2.12 writes it,
 * 4-space indented, with the main activity's attribute lines swappable. The last attribute
 * line carries the `>` that closes the start tag.
 */
export const androidManifest = (
  activityAttributes: readonly string[] = TEMPLATE_ACTIVITY_ATTRIBUTES,
  lineEnding = "\n"
) =>
  [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '    <uses-permission android:name="android.permission.INTERNET" />',
    "",
    "    <application",
    '        android:icon="@mipmap/ic_launcher"',
    '        android:label="@string/app_name"',
    '        android:theme="@style/Theme.my_app">',
    "        <activity",
    ...activityAttributes,
    "            <intent-filter>",
    '                <action android:name="android.intent.action.MAIN" />',
    '                <category android:name="android.intent.category.LAUNCHER" />',
    "            </intent-filter>",
    "        </activity>",
    "    </application>",
    "</manifest>",
    ""
  ].join(lineEnding);

/**
 * `gen/android/app/src/main/java/<identifier path>/MainActivity.kt`, byte for byte as
 * `tauri android init` (cli 2.12.1) writes it for the identifier `dev.moku.v6app`.
 */
export const REAL_MAIN_ACTIVITY = readFileSync(
  fileURLToPath(new URL("fixtures/MainActivity.real.kt", import.meta.url)),
  "utf8"
);

/** Where {@link REAL_MAIN_ACTIVITY} sits inside a `gen/android` tree. */
export const mainActivityPath = (genDirectory: string) =>
  path.join(genDirectory, "app", "src", "main", "java", "dev", "moku", "v6app", "MainActivity.kt");
