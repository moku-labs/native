import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { patchAndroidIcon } from "../../../mobile/icon";

/** The plain foreground `tauri icon` writes. */
const PLAIN = '<foreground android:drawable="@mipmap/ic_launcher_foreground"/>';

/** The foreground wrapped in an inset of `percent` per side. */
const inset = (percent: number) =>
  `<foreground><inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="${percent}%"/></foreground>`;

/** `mipmap-anydpi-v26/ic_launcher*.xml` around the given foreground element. */
const adaptiveIcon = (foreground: string) =>
  [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
    `  ${foreground}`,
    '  <background android:drawable="@color/ic_launcher_background"/>',
    "</adaptive-icon>",
    ""
  ].join("\n");

describe("patchAndroidIcon", () => {
  let dir: string;
  let genDir: string;
  let iconPath: string;
  let roundPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moku-native-icon-"));
    genDir = path.join(dir, "src-tauri", "gen", "android");
    const mipmap = path.join(genDir, "app", "src", "main", "res", "mipmap-anydpi-v26");
    iconPath = path.join(mipmap, "ic_launcher.xml");
    roundPath = path.join(mipmap, "ic_launcher_round.xml");
    await mkdir(mipmap, { recursive: true });
    await writeFile(iconPath, adaptiveIcon(PLAIN), "utf8");
    await writeFile(roundPath, adaptiveIcon(PLAIN), "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** One icon pass with `percent` per side, or unset. */
  const pass = (percent: number | undefined) =>
    patchAndroidIcon({ projectDirectory: dir, genDirectory: genDir, inset: percent });

  it("wraps the foreground of the icon and the round icon in the inset (bug: full-bleed art cut by the mask)", async () => {
    const result = await pass(19.44);

    expect(result.patched).toEqual([iconPath, roundPath]);
    expect(await readFile(iconPath, "utf8")).toBe(adaptiveIcon(inset(19.44)));
    expect(await readFile(roundPath, "utf8")).toBe(adaptiveIcon(inset(19.44)));
  });

  it("a second pass is a no-op (bug: a nested <inset> shrinks the icon every build)", async () => {
    await pass(19.44);

    const second = await pass(19.44);

    expect(second).toEqual({ patched: [], unchanged: [iconPath, roundPath] });
    expect(await readFile(iconPath, "utf8")).toBe(adaptiveIcon(inset(19.44)));
  });

  it("a changed inset replaces the old one (bug: a new value never reaches the icon)", async () => {
    await pass(19.44);

    await pass(25);

    expect(await readFile(iconPath, "utf8")).toBe(adaptiveIcon(inset(25)));
  });

  it("an unset inset restores the plain foreground (bug: opting out is impossible)", async () => {
    await pass(19.44);

    await pass(undefined);

    expect(await readFile(iconPath, "utf8")).toBe(adaptiveIcon(PLAIN));
    expect(await readFile(roundPath, "utf8")).toBe(adaptiveIcon(PLAIN));
  });

  it("is a no-op when the adaptive icon directory does not exist yet", async () => {
    await rm(path.dirname(iconPath), { recursive: true });

    expect(await pass(19.44)).toEqual({ patched: [], unchanged: [] });
  });
});
