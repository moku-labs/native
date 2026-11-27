import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../../../../../config";
import { launchKotlin } from "../../../mobile/launch-kotlin";
import {
  applyLaunchActivity,
  applyLaunchTheme,
  launchFrame,
  patchAndroidLaunchStill,
  readLaunchImage,
  resolveLaunch,
  stillPlacement
} from "../../../mobile/launch-still";
import { applySystemBarStyle } from "../../../mobile/system-bars";
import { applyWindowBackground } from "../../../mobile/window-background";
import type { LaunchRect, ResolvedLaunch } from "../../../types";
import { androidManifest, mainActivityPath, REAL_MAIN_ACTIVITY } from "./fixtures";

/** The A Memory Missing still: a 1024 × 1536 canvas, the art at (215, 402). */
const MEMORY_MISSING: ResolvedLaunch = {
  image: "/games/memory-missing/assets/splash/studio.webp",
  frame: { width: 1024, height: 1536 },
  rect: { x: 215, y: 402, width: 600, height: 640 },
  aspect: { min: 4 / 3, max: 21 / 9 },
  orientation: "portrait",
  holdMaxMs: 8000
};

/** The same still with some fields replaced. */
const still = (patch: Partial<ResolvedLaunch>): ResolvedLaunch => ({ ...MEMORY_MISSING, ...patch });

/** Rounds every side of a rectangle to `digits` decimals (and -0 to 0). */
const rounded = (rect: LaunchRect, digits = 6): LaunchRect => {
  const round = (value: number) => Number(value.toFixed(digits)) + 0;
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height)
  };
};

/** Writes a file, creating its folders. */
const seed = async (filePath: string, content: string | Uint8Array) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
};

/** A full app config around `launch`. */
const app = (patch: Partial<Config["app"]>): Config["app"] => ({
  name: "A Memory Missing",
  identifier: "studio.kitto.memorymissing",
  ...patch
});

const MARKER = "moku:native launch still";

/** {@link REAL_MAIN_ACTIVITY} with both launch hooks. */
const LAUNCH_ACTIVITY = [
  "package dev.moku.v6app",
  "",
  "import android.os.Bundle",
  "import androidx.activity.enableEdgeToEdge",
  "",
  "class MainActivity : TauriActivity() {",
  "  override fun onCreate(savedInstanceState: Bundle?) {",
  "    enableEdgeToEdge()",
  "    super.onCreate(savedInstanceState)",
  `    MokuLaunch.attach(this) // ${MARKER}`,
  "  }",
  `  override fun onWebViewCreate(webView: android.webkit.WebView) { // ${MARKER}`,
  `    super.onWebViewCreate(webView) // ${MARKER}`,
  `    MokuLaunch.bind(this, webView) // ${MARKER}`,
  `  } // ${MARKER}`,
  "}",
  ""
].join("\n");

/** `res/values/themes.xml` as `tauri android init` 2.12 writes it. */
const GENERATED_THEMES = [
  '<resources xmlns:tools="http://schemas.android.com/tools">',
  "    <!-- Base application theme. -->",
  '    <style name="Theme.my_app" parent="Theme.Material3.DayNight.NoActionBar">',
  "        <!-- Customize your theme here. -->",
  "    </style>",
  "</resources>",
  ""
].join("\n");

/** The translucent-start item, as the patch writes it. */
const TRANSLUCENT_ITEM = `        <item name="android:windowIsTranslucent">@bool/moku_launch_translucent</item> <!-- ${MARKER} -->`;

/** {@link GENERATED_THEMES} with the launch item. */
const LAUNCH_THEMES = GENERATED_THEMES.replace(
  "        <!-- Customize",
  `${TRANSLUCENT_ITEM}\n        <!-- Customize`
);

const THEMES_PATH = "/repo/.moku/tauri/src-tauri/gen/android/app/src/main/res/values/themes.xml";
const ACTIVITY_PATH = "/repo/MainActivity.kt";

/** Converts LF line endings to CRLF. */
const toCrlf = (text: string) => text.replaceAll("\n", "\r\n");

/** The first bytes of a PNG and of a WebP, enough for the image check. */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ascii = (text: string) => [...new TextEncoder().encode(text)];
const WEBP_BYTES = Uint8Array.from([...ascii("RIFF"), 4, 0, 0, 0, ...ascii("WEBPVP8 ")]);

/** The A Memory Missing `app.launch` as a game writes it, with no aspect. */
const CONFIGURED = {
  still: {
    image: "assets/splash/studio.webp",
    frame: { width: 1024, height: 1536 },
    rect: { x: 215, y: 402, width: 600, height: 640 }
  }
};

/** {@link CONFIGURED} through `resolveLaunch`, defaults filled. */
const resolvedDefaults = (): ResolvedLaunch => {
  const resolved = resolveLaunch(app({ launch: CONFIGURED }));
  if (resolved === undefined) throw new Error("app.launch did not resolve");
  return resolved;
};

describe("resolveLaunch", () => {
  const launch = CONFIGURED;

  it("is undefined without app.launch (bug: an app without a still gets one)", () => {
    expect(resolveLaunch(app({}))).toBeUndefined();
  });

  it("fills the defaults, the engine's aspect range among them, and resolves the image against the cwd, as app.icon is (bug: the patch reads the image from the gen tree)", () => {
    expect(resolveLaunch(app({ launch }))).toEqual({
      image: path.resolve("assets/splash/studio.webp"),
      frame: launch.still.frame,
      rect: launch.still.rect,
      aspect: { min: 4 / 3, max: 21 / 9 },
      orientation: "portrait",
      holdMaxMs: 8000
    });
  });

  it("reads the orientation from app.orientation when it is portrait or landscape, and portrait for any (bug: a landscape game reads its range the wrong way up)", () => {
    expect(resolveLaunch(app({ launch, orientation: "landscape" }))?.orientation).toBe("landscape");
    expect(resolveLaunch(app({ launch, orientation: "any" }))?.orientation).toBe("portrait");
  });

  it("lets launch.orientation and launch.holdMaxMs win over the defaults", () => {
    const resolved = resolveLaunch(
      app({
        launch: { ...launch, orientation: "portrait", holdMaxMs: 3000 },
        orientation: "landscape"
      })
    );

    expect(resolved?.orientation).toBe("portrait");
    expect(resolved?.holdMaxMs).toBe(3000);
  });
});

describe("launchFrame", () => {
  it("clamps a window taller than the range to a centred 360 × 840 frame (bug: the still is placed on the whole window)", () => {
    expect(rounded(launchFrame({ width: 360, height: 1000 }, MEMORY_MISSING))).toEqual({
      x: 0,
      y: 80,
      width: 360,
      height: 840
    });
  });

  it("narrows a window wider than the range to a centred frame (bug: only one side of the clamp is applied)", () => {
    expect(rounded(launchFrame({ width: 600, height: 700 }, MEMORY_MISSING))).toEqual({
      x: 37.5,
      y: 0,
      width: 525,
      height: 700
    });
  });

  it("keeps the whole window when its ratio is inside the range, also a range below 1 (bug: min 0.4 of the real game is refused or clamps)", () => {
    const window = { width: 384, height: 832 };

    expect(rounded(launchFrame(window, still({ aspect: { min: 0.4, max: 2.6 } })))).toEqual({
      x: 0,
      y: 0,
      ...window
    });
  });

  it("clamps to the engine's default range when the config gives no aspect (bug: the still is placed on the whole window the engine never fills)", () => {
    expect(rounded(launchFrame({ width: 360, height: 1000 }, resolvedDefaults()))).toEqual({
      x: 0,
      y: 80,
      width: 360,
      height: 840
    });
  });

  it("reads the range in landscape (bug: the long side is taken as the height)", () => {
    expect(
      rounded(launchFrame({ width: 1000, height: 360 }, still({ orientation: "landscape" })))
    ).toEqual({
      x: 80,
      y: 0,
      width: 840,
      height: 360
    });
  });
});

describe("stillPlacement", () => {
  it("places the A Memory Missing still where the A26 measured it", () => {
    const place = stillPlacement({ width: 384, height: 832 }, MEMORY_MISSING);

    expect(rounded(place, 3)).toEqual({ x: 31.125, y: 217.75, width: 325, height: 346.667 });
    // The point (515, 702) of the canvas lands at (193.625, 380.25): 300 canvas units past
    // the rect's corner on both axes, at the scale 832 / 1536 of this window.
    expect(place.x + 300 * (832 / 1536)).toBeCloseTo(193.625, 3);
    expect(place.y + 300 * (832 / 1536)).toBeCloseTo(380.25, 3);
  });

  it("places the still inside the clamped frame, not the window", () => {
    expect(rounded(stillPlacement({ width: 360, height: 1000 }, MEMORY_MISSING))).toEqual({
      x: 17.578_125,
      y: 299.843_75,
      width: 328.125,
      height: 350
    });
  });

  it("places the still in the default range's frame when the config gives no aspect, the canvas overflowing it vertically", () => {
    expect(rounded(stillPlacement({ width: 600, height: 700 }, resolvedDefaults()))).toEqual({
      x: 147.729_492,
      y: 162.353_516,
      width: 307.617_188,
      height: 328.125
    });
  });

  it("covers a landscape frame with a landscape canvas", () => {
    const landscape = still({
      orientation: "landscape",
      frame: { width: 1536, height: 1024 },
      rect: { x: 0, y: 0, width: 1536, height: 1024 }
    });

    expect(rounded(stillPlacement({ width: 1000, height: 360 }, landscape))).toEqual({
      x: 80,
      y: -100,
      width: 840,
      height: 560
    });
  });
});

describe("applyLaunchActivity", () => {
  it("attaches after super.onCreate and binds in a new onWebViewCreate before the class's last brace", () => {
    expect(applyLaunchActivity(REAL_MAIN_ACTIVITY, true, ACTIVITY_PATH)).toBe(LAUNCH_ACTIVITY);
  });

  it("is idempotent — a second pass changes nothing", () => {
    expect(applyLaunchActivity(LAUNCH_ACTIVITY, true, ACTIVITY_PATH)).toBe(LAUNCH_ACTIVITY);
  });

  it("restores the generated bytes exactly when disabled", () => {
    expect(applyLaunchActivity(LAUNCH_ACTIVITY, false, ACTIVITY_PATH)).toBe(REAL_MAIN_ACTIVITY);
  });

  it("keeps CRLF line endings", () => {
    expect(applyLaunchActivity(toCrlf(REAL_MAIN_ACTIVITY), true, ACTIVITY_PATH)).toBe(
      toCrlf(LAUNCH_ACTIVITY)
    );
    expect(applyLaunchActivity(toCrlf(LAUNCH_ACTIVITY), false, ACTIVITY_PATH)).toBe(
      toCrlf(REAL_MAIN_ACTIVITY)
    );
  });

  it("gives the same file with the system bar patch applied before or after (bug: the two patches fight over a line)", () => {
    const barsFirst = applyLaunchActivity(
      applySystemBarStyle(REAL_MAIN_ACTIVITY, "dark", ACTIVITY_PATH),
      true,
      ACTIVITY_PATH
    );
    const launchFirst = applySystemBarStyle(
      applyLaunchActivity(REAL_MAIN_ACTIVITY, true, ACTIVITY_PATH),
      "dark",
      ACTIVITY_PATH
    );

    expect(barsFirst).toBe(launchFirst);
    expect(barsFirst).toContain("SystemBarStyle.dark(");
    expect(barsFirst).toContain("MokuLaunch.bind(this, webView)");
  });

  it("refuses an activity that overrides onWebViewCreate itself (bug: a second override does not compile)", () => {
    const foreign = REAL_MAIN_ACTIVITY.replace(
      "\n}\n",
      "\n  override fun onWebViewCreate(webView: android.webkit.WebView) { }\n}\n"
    );

    expect(() => applyLaunchActivity(foreign, true, ACTIVITY_PATH)).toThrow(
      `[native] ${ACTIVITY_PATH} already overrides onWebViewCreate, so the launch still cannot bind the page.\n  Remove that override, or unset app.launch.`
    );
  });

  it("refuses an activity without super.onCreate(savedInstanceState)", () => {
    const source = REAL_MAIN_ACTIVITY.replace("    super.onCreate(savedInstanceState)\n", "");

    expect(() => applyLaunchActivity(source, true, ACTIVITY_PATH)).toThrow(
      `[native] ${ACTIVITY_PATH} has no super.onCreate(savedInstanceState) line to attach the launch still after.\n  Re-run the mobile init pass (tauri android init), or unset app.launch.`
    );
  });

  it("refuses an activity whose class does not end in a brace of its own line", () => {
    const source = "class A { fun onCreate() { super.onCreate(savedInstanceState) } }\n";

    expect(() => applyLaunchActivity(source, true, ACTIVITY_PATH)).toThrow(
      `[native] ${ACTIVITY_PATH} has no closing brace of its class to add onWebViewCreate before.`
    );
  });
});

describe("applyLaunchTheme", () => {
  it("sets the translucent start as the app theme's first item", () => {
    expect(applyLaunchTheme(GENERATED_THEMES, "Theme.my_app", true, THEMES_PATH)).toBe(
      LAUNCH_THEMES
    );
  });

  it("goes after the window background lines, so both patches together are a no-op on a second pass (bug: the window patch moves the launch line every pass)", () => {
    const windowed = applyWindowBackground(GENERATED_THEMES, "Theme.my_app", true, THEMES_PATH);
    const both = applyLaunchTheme(windowed, "Theme.my_app", true, THEMES_PATH);
    const again = applyLaunchTheme(
      applyWindowBackground(both, "Theme.my_app", true, THEMES_PATH),
      "Theme.my_app",
      true,
      THEMES_PATH
    );

    const lines = both.split("\n");
    expect(lines[5]).toBe(TRANSLUCENT_ITEM);
    expect(lines[3]).toContain("android:windowBackground");
    expect(again).toBe(both);
  });

  it("is idempotent and restores the generated bytes when cleared, CRLF included", () => {
    expect(applyLaunchTheme(LAUNCH_THEMES, "Theme.my_app", true, THEMES_PATH)).toBe(LAUNCH_THEMES);
    expect(applyLaunchTheme(LAUNCH_THEMES, "Theme.my_app", false, THEMES_PATH)).toBe(
      GENERATED_THEMES
    );
    expect(applyLaunchTheme(toCrlf(GENERATED_THEMES), "Theme.my_app", true, THEMES_PATH)).toBe(
      toCrlf(LAUNCH_THEMES)
    );
  });

  it("indents the item one level below an empty style", () => {
    const source =
      '<resources>\n  <style name="Theme.my_app" parent="P">\n  </style>\n</resources>\n';

    expect(applyLaunchTheme(source, "Theme.my_app", true, THEMES_PATH)).toContain(
      '\n      <item name="android:windowIsTranslucent">'
    );
  });

  it("refuses a themes file without the app theme, in the launch wording", () => {
    expect(() => applyLaunchTheme(GENERATED_THEMES, "Theme.gone", true, THEMES_PATH)).toThrow(
      `[native] ${THEMES_PATH} has no <style name="Theme.gone"> to start without the system splash in.\n  Re-run the mobile init pass (tauri android init), or unset app.launch.`
    );
  });
});

describe("launchKotlin", () => {
  const kotlin = launchKotlin({
    packageName: "dev.moku.v6app",
    launch: MEMORY_MISSING,
    backgroundColor: "#F4E6CA"
  });

  it("opens with the activity's package and the marker", () => {
    expect(kotlin.startsWith("package dev.moku.v6app\n\n")).toBe(true);
    expect(kotlin).toContain(
      `// ${MARKER} — generated by @moku-labs/native from app.launch. Do not edit.`
    );
  });

  it("writes every number of the config as a literal (bug: the Kotlin draws the still at another place than the page)", () => {
    for (const line of [
      "private const val BACKGROUND = 0xFFF4E6CA.toInt()",
      "private const val FRAME_W = 1024f",
      "private const val FRAME_H = 1536f",
      "private const val RECT_X = 215f",
      "private const val RECT_Y = 402f",
      "private const val RECT_W = 600f",
      "private const val RECT_H = 640f",
      "private const val ASPECT_MIN = 1.333333f",
      "private const val ASPECT_MAX = 2.333333f",
      "private const val PORTRAIT = true",
      "private const val HOLD_MAX_MS = 8000L",
      "private const val OPAQUE_AFTER_MS = 700L"
    ]) {
      expect(kotlin).toContain(`  ${line}\n`);
    }
  });

  it("writes the aspect to six decimals, false for landscape and a fractional place as is", () => {
    const landscape = launchKotlin({
      packageName: "a.b",
      launch: still({
        aspect: { min: 0.4, max: 2.6 },
        orientation: "landscape",
        rect: { x: 12.5, y: 0, width: 600, height: 640 }
      }),
      backgroundColor: "#10161d"
    });

    expect(landscape).toContain("  private const val ASPECT_MIN = 0.400000f\n");
    expect(landscape).toContain("  private const val ASPECT_MAX = 2.600000f\n");
    expect(landscape).toContain("  private const val PORTRAIT = false\n");
    expect(landscape).toContain("  private const val RECT_X = 12.5f\n");
  });

  it("forces the background opaque and is white without a colour (bug: a see-through first frame shows the launcher)", () => {
    const withAlpha = launchKotlin({
      packageName: "a.b",
      launch: MEMORY_MISSING,
      backgroundColor: "#10161d80"
    });
    const unset = launchKotlin({
      packageName: "a.b",
      launch: MEMORY_MISSING,
      backgroundColor: undefined
    });

    expect(withAlpha).toContain("  private const val BACKGROUND = 0xFF10161D.toInt()\n");
    expect(unset).toContain("  private const val BACKGROUND = 0xFFFFFFFF.toInt()\n");
  });

  it("turns the window opaque and warns when the still cannot be decoded (bug: the window stays translucent all session)", () => {
    expect(kotlin).toContain(
      [
        "    val bitmap = BitmapFactory.decodeResource(activity.resources, id, options)",
        "    if (bitmap == null) {",
        "      // No still to draw: the window must still turn opaque, or it stays translucent all session.",
        '      Log.w("moku", "launch: the still picture could not be decoded")',
        "      if (Build.VERSION.SDK_INT >= 30) activity.window.decorView.postDelayed({ activity.setTranslucent(false) }, OPAQUE_AFTER_MS)",
        "      return",
        "    }",
        "    val view = StillView(activity, bitmap)"
      ].join("\n")
    );
  });

  it("draws by the same maths as stillPlacement (bug: the shell puts the still elsewhere than the page)", () => {
    expect(kotlin).toContain(
      [
        "    override fun onDraw(canvas: Canvas) {",
        "      canvas.drawColor(BACKGROUND)",
        "      val w = width.toFloat()",
        "      val h = height.toFloat()",
        "      if (w <= 0f || h <= 0f) return",
        "      // The game frame: the largest centred rectangle whose long / short side is inside the aspect range.",
        "      val short = if (PORTRAIT) w else h",
        "      val long = if (PORTRAIT) h else w",
        "      val ratio = long / short",
        "      val wanted = ratio.coerceIn(ASPECT_MIN, ASPECT_MAX)",
        "      val frameShort = if (ratio < wanted) long / wanted else short",
        "      val frameLong = if (ratio > wanted) short * wanted else long",
        "      val frameW = if (PORTRAIT) frameShort else frameLong",
        "      val frameH = if (PORTRAIT) frameLong else frameShort",
        "      // The still's canvas covers that frame, centred; the picture lies in its rectangle.",
        "      val k = maxOf(frameW / FRAME_W, frameH / FRAME_H)",
        "      val left = (w - frameW) / 2f + (frameW - FRAME_W * k) / 2f + RECT_X * k",
        "      val top = (h - frameH) / 2f + (frameH - FRAME_H * k) / 2f + RECT_Y * k",
        "      place.set(left, top, left + RECT_W * k, top + RECT_H * k)",
        "      canvas.drawBitmap(bitmap, null, place, paint)",
        "    }"
      ].join("\n")
    );
  });

  it("leaves no placeholder of the template", () => {
    // `<n>`, `<0xAARRGGBB>`, `<true|false>`, `<package of MainActivity.kt>`
    expect(kotlin).not.toMatch(/<[\w .|]+>/);
  });
});

describe("readLaunchImage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-launch-image-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tells a PNG and a WebP by their first bytes, whatever the name says", async () => {
    await writeFile(path.join(dir, "a.png"), WEBP_BYTES);
    await writeFile(path.join(dir, "b.webp"), PNG_BYTES);

    const named = await readLaunchImage(path.join(dir, "a.png"));
    const misnamed = await readLaunchImage(path.join(dir, "b.webp"));

    expect(named.extension).toBe("webp");
    expect(misnamed.extension).toBe("png");
  });

  it("refuses a missing file and a file that is no image, naming the field", async () => {
    const missing = path.join(dir, "gone.png");
    const text = path.join(dir, "notes.png");
    await writeFile(text, "RIFF but not a picture", "utf8");

    await expect(readLaunchImage(missing)).rejects.toThrow(
      `[native] app.launch.still.image was not found at ${missing}.\n  Point app.launch.still.image at the still picture, a .png or .webp file.`
    );
    await expect(readLaunchImage(text)).rejects.toThrow(
      `[native] app.launch.still.image ${text} is not a PNG or WebP image by its first bytes.\n  Export the still as PNG or WebP, or point app.launch.still.image at the right file.`
    );
  });
});

describe("patchAndroidLaunchStill", () => {
  let dir: string;
  let genDir: string;
  let resDir: string;
  let activity: string;
  let kotlin: string;
  let dayThemes: string;
  let nightThemes: string;
  let manifestPath: string;
  let image: string;

  /** The files a launch pass writes, in report order. */
  const owned = (extension = "webp") => [
    path.join(resDir, "drawable-nodpi", `moku_launch_still.${extension}`),
    path.join(resDir, "values", "moku_launch.xml"),
    path.join(resDir, "values-v30", "moku_launch.xml")
  ];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-launch-still-"));
    genDir = path.join(dir, "src-tauri", "gen", "android");
    resDir = path.join(genDir, "app", "src", "main", "res");
    activity = mainActivityPath(genDir);
    kotlin = path.join(path.dirname(activity), "MokuLaunch.kt");
    dayThemes = path.join(resDir, "values", "themes.xml");
    nightThemes = path.join(resDir, "values-night", "themes.xml");
    manifestPath = path.join(genDir, "app", "src", "main", "AndroidManifest.xml");
    image = path.join(dir, "studio.webp");
    await seed(manifestPath, androidManifest());
    await seed(activity, REAL_MAIN_ACTIVITY);
    await seed(dayThemes, GENERATED_THEMES);
    await seed(nightThemes, GENERATED_THEMES);
    await seed(image, WEBP_BYTES);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A pass with the A Memory Missing still at `image`. */
  const patch = (launch: ResolvedLaunch = still({ image })) =>
    patchAndroidLaunchStill(dir, genDir, launch, "#F4E6CA");

  /** A pass with app.launch unset. */
  const unset = () => patchAndroidLaunchStill(dir, genDir, undefined, "#F4E6CA");

  it("writes all six kinds of file, then reports every one unchanged (bug: every build rewrites them and Gradle rebuilds)", async () => {
    const files = [...owned(), dayThemes, nightThemes, kotlin, activity];

    const first = await patch();
    const second = await patch();

    expect(first).toEqual({ patched: files, unchanged: [] });
    expect(second).toEqual({ patched: [], unchanged: files });
    const [drawable, values, valuesV30] = owned();
    expect(await readFile(drawable ?? "")).toEqual(Buffer.from(WEBP_BYTES));
    expect(await readFile(values ?? "", "utf8")).toContain(
      '<bool name="moku_launch_translucent">false</bool>'
    );
    expect(await readFile(valuesV30 ?? "", "utf8")).toContain(
      '<bool name="moku_launch_translucent">true</bool>'
    );
    expect(await readFile(dayThemes, "utf8")).toBe(LAUNCH_THEMES);
    expect(await readFile(nightThemes, "utf8")).toBe(LAUNCH_THEMES);
    expect(await readFile(activity, "utf8")).toBe(LAUNCH_ACTIVITY);
    expect(await readFile(kotlin, "utf8")).toBe(
      launchKotlin({
        packageName: "dev.moku.v6app",
        launch: still({ image }),
        backgroundColor: "#F4E6CA"
      })
    );
  });

  it("swaps a .png still for a .webp one and removes the old drawable (bug: two drawables of one name fail the Gradle merge)", async () => {
    const png = path.join(dir, "studio.png");
    await seed(png, PNG_BYTES);
    await patch(still({ image: png }));

    const result = await patch();

    expect(existsSync(owned("png")[0] ?? "")).toBe(false);
    expect(existsSync(owned("webp")[0] ?? "")).toBe(true);
    expect(result.patched).toEqual([owned("webp")[0], owned("png")[0]]);
  });

  it("unset removes the owned files and restores MainActivity.kt and themes.xml byte for byte", async () => {
    await patch();

    const result = await unset();

    expect(result.unchanged).toEqual([]);
    expect(result.patched.toSorted()).toEqual(
      [...owned(), dayThemes, nightThemes, kotlin, activity].toSorted()
    );
    for (const file of [...owned(), kotlin]) expect(existsSync(file)).toBe(false);
    expect(await readFile(activity, "utf8")).toBe(REAL_MAIN_ACTIVITY);
    expect(await readFile(dayThemes, "utf8")).toBe(GENERATED_THEMES);
    expect(await readFile(nightThemes, "utf8")).toBe(GENERATED_THEMES);
  });

  it("unset reports nothing on a tree it never touched or a bare one, and never throws (bug: an app without a still stops building)", async () => {
    await expect(unset()).resolves.toEqual({ patched: [], unchanged: [] });

    await rm(path.join(genDir, "app"), { recursive: true });
    await expect(unset()).resolves.toEqual({ patched: [], unchanged: [] });
  });

  it("unset keeps a moku_launch.xml and a MokuLaunch.kt native did not write", async () => {
    const values = owned()[1] ?? "";
    await seed(values, "<resources/>\n");
    await seed(kotlin, "object MokuLaunch\n");

    await unset();

    expect(await readFile(values, "utf8")).toBe("<resources/>\n");
    expect(await readFile(kotlin, "utf8")).toBe("object MokuLaunch\n");
  });

  it("refuses a file that is not an image before anything is written", async () => {
    await seed(image, "not a picture");

    await expect(patch()).rejects.toThrow("is not a PNG or WebP image by its first bytes");
    expect(await readFile(activity, "utf8")).toBe(REAL_MAIN_ACTIVITY);
    expect(await readFile(dayThemes, "utf8")).toBe(GENERATED_THEMES);
    expect(existsSync(path.join(resDir, "drawable-nodpi"))).toBe(false);
  });

  it("refuses a MokuLaunch.kt native did not write, before anything is written (bug: a hand-written file is overwritten)", async () => {
    await seed(kotlin, "object MokuLaunch\n");

    await expect(patch()).rejects.toThrow(
      `[native] ${kotlin} exists and was not written by @moku-labs/native.\n  Move it away, or unset app.launch.`
    );
    expect(await readFile(activity, "utf8")).toBe(REAL_MAIN_ACTIVITY);
    expect(existsSync(path.join(resDir, "drawable-nodpi"))).toBe(false);
  });

  it("refuses a tree without exactly one MainActivity.kt that calls super.onCreate", async () => {
    const javaDir = path.join(genDir, "app", "src", "main", "java");
    const second = path.join(javaDir, "dev", "moku", "other", "MainActivity.kt");
    await seed(second, REAL_MAIN_ACTIVITY);

    await expect(patch()).rejects.toThrow(
      `[native] Found 2 MainActivity.kt files that call super.onCreate(savedInstanceState) under ${javaDir}: ${second}, ${activity}.`
    );

    await rm(second);
    await seed(activity, REAL_MAIN_ACTIVITY.replace("super.onCreate(savedInstanceState)", ""));
    await expect(patch()).rejects.toThrow(
      `[native] Could not find the MainActivity.kt that calls super.onCreate(savedInstanceState) under ${javaDir}.\n  Re-run the mobile init pass (tauri android init), or unset app.launch.`
    );
  });

  it("accepts a second MainActivity.kt that does not call super.onCreate", async () => {
    const other = path.join(genDir, "app", "src", "main", "java", "a", "MainActivity.kt");
    await seed(other, "package a\n");

    await patch();

    expect(await readFile(activity, "utf8")).toBe(LAUNCH_ACTIVITY);
    expect(await readFile(other, "utf8")).toBe("package a\n");
  });

  it("refuses an activity without a package line", async () => {
    await seed(activity, REAL_MAIN_ACTIVITY.replace("package dev.moku.v6app\n", ""));

    await expect(patch()).rejects.toThrow(
      `[native] ${activity} has no package line to give MokuLaunch.kt.\n  Re-run the mobile init pass (tauri android init), or unset app.launch.`
    );
  });

  it("names app.launch when the manifest names no app theme or the day theme is missing", async () => {
    await seed(manifestPath, androidManifest().replace(' android:theme="@style/Theme.my_app"', ""));
    await expect(patch()).rejects.toThrow(
      `[native] ${manifestPath} names no android:theme on <application> to start without the system splash in.\n  Re-run the mobile init pass (tauri android init), or unset app.launch.`
    );

    await seed(manifestPath, androidManifest());
    await rm(dayThemes);
    await expect(patch()).rejects.toThrow(
      `[native] ${dayThemes} not found.\n  Re-run the mobile init pass (tauri android init), or unset app.launch.`
    );
    expect(await readFile(activity, "utf8")).toBe(REAL_MAIN_ACTIVITY);
  });

  it("leaves a night theme file without the app theme as it is", async () => {
    const otherNight = GENERATED_THEMES.replace("Theme.my_app", "Theme.other");
    await seed(nightThemes, otherNight);

    const result = await patch();

    expect(result.patched).not.toContain(nightThemes);
    expect(result.unchanged).toContain(nightThemes);
    expect(await readFile(nightThemes, "utf8")).toBe(otherNight);
  });

  it("refuses a day theme file without the app theme", async () => {
    await seed(dayThemes, GENERATED_THEMES.replace("Theme.my_app", "Theme.other"));

    await expect(patch()).rejects.toThrow(
      `[native] ${dayThemes} has no <style name="Theme.my_app"> to start without the system splash in.`
    );
  });

  it("uses the image bytes the caller already checked", async () => {
    await patchAndroidLaunchStill(dir, genDir, still({ image: "/nowhere.png" }), undefined, {
      bytes: PNG_BYTES,
      extension: "png"
    });

    expect(await readFile(owned("png")[0] ?? "")).toEqual(Buffer.from(PNG_BYTES));
  });
});
