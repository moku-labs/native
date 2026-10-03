import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyManifestEntries, patchAndroidManifest } from "../../../mobile/manifest";
import { orientationManifest } from "../../../orientation";
import type { ManifestEntry } from "../../../types";
import { androidManifest, screenOrientationLine, TEMPLATE_ACTIVITY_ATTRIBUTES } from "./fixtures";

const MANIFEST_PATH = "/repo/.moku/tauri/src-tauri/gen/android/app/src/main/AndroidManifest.xml";

const PORTRAIT = orientationManifest("portrait");
const LANDSCAPE = orientationManifest("landscape");
const ANY = orientationManifest("any");

/** The template's attribute lines with the closing `>` moved off the last one. */
const ATTRIBUTES_WITHOUT_CLOSE = TEMPLATE_ACTIVITY_ATTRIBUTES.map(line => line.replace(/>$/, ""));

/** A main-activity error for the fixture path. */
const MAIN_ACTIVITY_ERROR = `[native] Could not find the main <activity> in ${MANIFEST_PATH}.\n  Re-run the mobile init pass (tauri android init) or report the manifest Tauri generated.`;

/** A manifest carrying the given `<application>` body lines, 4-space indented. */
const manifestWithApplication = (...body: string[]) =>
  [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    "    <application>",
    ...body,
    "    </application>",
    "</manifest>",
    ""
  ].join("\n");

/** A non-self-closing activity whose body declares MAIN, 8-space indented. */
const mainActivityLines = (name: string) => [
  `        <activity android:name="${name}">`,
  '            <action android:name="android.intent.action.MAIN" />',
  "        </activity>"
];

describe("applyManifestEntries", () => {
  it("inserts a new attribute as the activity's first line, at the next attribute's indent", () => {
    expect(applyManifestEntries(androidManifest(), PORTRAIT, MANIFEST_PATH)).toBe(
      androidManifest([screenOrientationLine("portrait"), ...TEMPLATE_ACTIVITY_ATTRIBUTES])
    );
  });

  it("replaces an existing value in place, wherever the attribute sits", () => {
    const [first, second, ...rest] = TEMPLATE_ACTIVITY_ATTRIBUTES;
    const landscape = androidManifest([
      first ?? "",
      screenOrientationLine("sensorLandscape"),
      second ?? "",
      ...rest
    ]);

    expect(applyManifestEntries(landscape, PORTRAIT, MANIFEST_PATH)).toBe(
      androidManifest([first ?? "", screenOrientationLine("portrait"), second ?? "", ...rest])
    );
  });

  it("removes the attribute line when the value is undefined", () => {
    const portrait = androidManifest([
      screenOrientationLine("portrait"),
      ...TEMPLATE_ACTIVITY_ATTRIBUTES
    ]);

    expect(applyManifestEntries(portrait, ANY, MANIFEST_PATH)).toBe(androidManifest());
  });

  it("removes the attribute when it is the last one before the closing `>`", () => {
    const portrait = androidManifest([
      ...ATTRIBUTES_WITHOUT_CLOSE,
      `${screenOrientationLine("portrait")}>`
    ]);

    expect(applyManifestEntries(portrait, ANY, MANIFEST_PATH)).toBe(androidManifest());
  });

  it("leaves a manifest without the attribute unchanged when asked to remove it", () => {
    expect(applyManifestEntries(androidManifest(), ANY, MANIFEST_PATH)).toBe(androidManifest());
  });

  it("is idempotent — applying twice equals applying once", () => {
    const once = applyManifestEntries(androidManifest(), LANDSCAPE, MANIFEST_PATH);

    expect(applyManifestEntries(once, LANDSCAPE, MANIFEST_PATH)).toBe(once);
  });

  it("keeps CRLF line endings on insert and on removal", () => {
    const crlf = androidManifest(TEMPLATE_ACTIVITY_ATTRIBUTES, "\r\n");
    const inserted = applyManifestEntries(crlf, PORTRAIT, MANIFEST_PATH);

    expect(inserted).toBe(
      androidManifest([screenOrientationLine("portrait"), ...TEMPLATE_ACTIVITY_ATTRIBUTES], "\r\n")
    );
    expect(inserted).not.toMatch(/[^\r]\n/);
    expect(applyManifestEntries(inserted, ANY, MANIFEST_PATH)).toBe(crlf);
  });

  it("inserts with one space when the attributes share the `<activity` line", () => {
    const sameLine = manifestWithApplication(
      '        <activity android:name=".MainActivity" android:exported="true">',
      '            <intent-filter><action android:name="android.intent.action.MAIN" /></intent-filter>',
      "        </activity>"
    );

    expect(applyManifestEntries(sameLine, PORTRAIT, MANIFEST_PATH)).toContain(
      '        <activity android:screenOrientation="portrait" android:name=".MainActivity" android:exported="true">'
    );
  });

  it("gives an attribute-less `<activity>` its first attribute", () => {
    const bare = manifestWithApplication(
      "        <activity>",
      '            <action android:name="android.intent.action.MAIN" />',
      "        </activity>"
    );

    expect(applyManifestEntries(bare, PORTRAIT, MANIFEST_PATH)).toContain(
      '        <activity android:screenOrientation="portrait">'
    );
  });

  it("replaces a single-quoted value", () => {
    const quoted = manifestWithApplication(
      "        <activity android:screenOrientation='landscape' android:name='.MainActivity' />"
    );

    expect(applyManifestEntries(quoted, PORTRAIT, MANIFEST_PATH)).toContain(
      `        <activity android:screenOrientation="portrait" android:name='.MainActivity' />`
    );
  });

  it("picks the activity whose body declares MAIN among several", () => {
    const settings = [
      "        <activity",
      '            android:name=".SettingsActivity">',
      "        </activity>"
    ];
    const main = [
      "        <activity",
      '            android:name=".MainActivity">',
      '            <action android:name="android.intent.action.MAIN" />',
      "        </activity>"
    ];

    expect(
      applyManifestEntries(manifestWithApplication(...settings, ...main), PORTRAIT, MANIFEST_PATH)
    ).toBe(
      manifestWithApplication(
        ...settings,
        "        <activity",
        screenOrientationLine("portrait"),
        ...main.slice(1)
      )
    );
  });

  it("falls back to the only activity when none declares MAIN", () => {
    const only = manifestWithApplication('        <activity android:name=".MainActivity" />');

    expect(applyManifestEntries(only, PORTRAIT, MANIFEST_PATH)).toContain(
      '        <activity android:screenOrientation="portrait" android:name=".MainActivity" />'
    );
  });

  it("never counts an `<activity-alias>` or a commented-out activity", () => {
    const manifest = manifestWithApplication(
      '        <!-- <activity android:name=".Old"><action android:name="android.intent.action.MAIN" /></activity> -->',
      '        <activity android:name=".MainActivity" />',
      '        <activity-alias android:name=".Alias" android:targetActivity=".MainActivity">',
      '            <action android:name="android.intent.action.MAIN" />',
      "        </activity-alias>"
    );

    const patched = applyManifestEntries(manifest, PORTRAIT, MANIFEST_PATH);

    expect(patched).toContain(
      '        <activity android:screenOrientation="portrait" android:name=".MainActivity" />'
    );
    expect(patched.match(/screenOrientation/g)).toHaveLength(1);
  });

  it("throws when several activities exist and none declares MAIN", () => {
    const manifest = manifestWithApplication(
      '        <activity android:name=".A" />',
      '        <activity android:name=".B" />'
    );

    expect(() => applyManifestEntries(manifest, PORTRAIT, MANIFEST_PATH)).toThrow(
      MAIN_ACTIVITY_ERROR
    );
  });

  it("throws when several activities declare MAIN", () => {
    expect(() =>
      applyManifestEntries(
        manifestWithApplication(...mainActivityLines(".A"), ...mainActivityLines(".B")),
        PORTRAIT,
        MANIFEST_PATH
      )
    ).toThrow(MAIN_ACTIVITY_ERROR);
  });

  it("never ends a start tag at a `>` inside a quoted value", () => {
    const manifest = manifestWithApplication(
      '        <activity android:label="a > b" android:name=".MainActivity">',
      '            <action android:name="android.intent.action.MAIN" />',
      "        </activity>"
    );

    expect(applyManifestEntries(manifest, PORTRAIT, MANIFEST_PATH)).toContain(
      '        <activity android:screenOrientation="portrait" android:label="a > b" android:name=".MainActivity">'
    );
  });

  it("does not count a start tag that never closes", () => {
    const truncated = '<manifest>\n    <application>\n        <activity android:name=".A"';

    expect(() => applyManifestEntries(truncated, PORTRAIT, MANIFEST_PATH)).toThrow(
      MAIN_ACTIVITY_ERROR
    );
  });

  it("leaves a manifest without a clear main activity alone when only removing", () => {
    const ambiguous = manifestWithApplication(
      ...mainActivityLines(".A"),
      ...mainActivityLines(".B")
    );

    expect(applyManifestEntries(ambiguous, ANY, MANIFEST_PATH)).toBe(ambiguous);
    expect(applyManifestEntries("generated\n", ANY, MANIFEST_PATH)).toBe("generated\n");
  });

  it("throws when the manifest carries no activity at all", () => {
    expect(() => applyManifestEntries(manifestWithApplication(), PORTRAIT, MANIFEST_PATH)).toThrow(
      MAIN_ACTIVITY_ERROR
    );
  });

  it("does not apply `child` entries", () => {
    const child: ManifestEntry = {
      kind: "child",
      parentTag: "manifest",
      xml: '<uses-permission android:name="android.permission.VIBRATE" />'
    };

    expect(applyManifestEntries(androidManifest(), [child], MANIFEST_PATH)).toBe(androidManifest());
  });

  it("XML-escapes the attribute value", () => {
    const entry: ManifestEntry = {
      kind: "activity-attribute",
      name: "android:label",
      value: 'Tom & "Jerry"'
    };

    expect(applyManifestEntries(androidManifest(), [entry], MANIFEST_PATH)).toContain(
      '            android:label="Tom &amp; &quot;Jerry&quot;"'
    );
  });
});

describe("patchAndroidManifest", () => {
  let dir: string;
  let genDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-manifest-"));
    genDir = path.join(dir, "src-tauri", "gen", "android");
    manifestPath = path.join(genDir, "app", "src", "main", "AndroidManifest.xml");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes the template manifest (or the given content) where tauri android init puts it. */
  const seedManifest = async (content = androidManifest()) => {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, content, "utf8");
  };

  it("inserts the attribute on the first pass and reports unchanged on the second", async () => {
    await seedManifest();

    const first = await patchAndroidManifest(dir, genDir, PORTRAIT);
    const second = await patchAndroidManifest(dir, genDir, PORTRAIT);

    expect(first).toEqual({ patched: [manifestPath], unchanged: [] });
    expect(second).toEqual({ patched: [], unchanged: [manifestPath] });
    expect(await readFile(manifestPath, "utf8")).toBe(
      androidManifest([screenOrientationLine("portrait"), ...TEMPLATE_ACTIVITY_ATTRIBUTES])
    );
  });

  it("replaces a landscape lock with portrait", async () => {
    await seedManifest(
      androidManifest([screenOrientationLine("sensorLandscape"), ...TEMPLATE_ACTIVITY_ATTRIBUTES])
    );

    await patchAndroidManifest(dir, genDir, PORTRAIT);

    expect(await readFile(manifestPath, "utf8")).toBe(
      androidManifest([screenOrientationLine("portrait"), ...TEMPLATE_ACTIVITY_ATTRIBUTES])
    );
  });

  it("removes a previous lock when the app goes back to any", async () => {
    await seedManifest(
      androidManifest([screenOrientationLine("portrait"), ...TEMPLATE_ACTIVITY_ATTRIBUTES])
    );

    const result = await patchAndroidManifest(dir, genDir, ANY);

    expect(result.patched).toEqual([manifestPath]);
    expect(await readFile(manifestPath, "utf8")).toBe(androidManifest());
  });

  it("patches a CRLF manifest without changing its line endings", async () => {
    await seedManifest(androidManifest(TEMPLATE_ACTIVITY_ATTRIBUTES, "\r\n"));

    await patchAndroidManifest(dir, genDir, LANDSCAPE);

    expect(await readFile(manifestPath, "utf8")).toBe(
      androidManifest(
        [screenOrientationLine("sensorLandscape"), ...TEMPLATE_ACTIVITY_ATTRIBUTES],
        "\r\n"
      )
    );
  });

  it("throws a fix-it when the manifest is missing", async () => {
    await expect(patchAndroidManifest(dir, genDir, PORTRAIT)).rejects.toThrow(
      `[native] AndroidManifest.xml not found at ${manifestPath}.\n  Re-run the mobile init pass (tauri android init) before patching the manifest.`
    );
  });

  it("throws when the manifest has no main activity", async () => {
    await seedManifest(
      manifestWithApplication(
        '        <activity android:name=".A" />',
        '        <activity android:name=".B" />'
      )
    );

    await expect(patchAndroidManifest(dir, genDir, PORTRAIT)).rejects.toThrow(
      `[native] Could not find the main <activity> in ${manifestPath}.`
    );
  });

  it("reads and reports nothing when no entry is an activity attribute", async () => {
    const result = await patchAndroidManifest(dir, genDir, []);

    expect(result).toEqual({ patched: [], unchanged: [] });
    expect(existsSync(manifestPath)).toBe(false);
  });
});
