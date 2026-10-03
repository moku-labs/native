import { describe, expect, it } from "vitest";

import { orientationManifest, orientationPlist } from "../../orientation";

describe("orientationPlist", () => {
  it("locks iPhone to portrait, iPad to both portrait sides, and asks for full screen", () => {
    expect(orientationPlist("portrait")).toEqual([
      { key: "UISupportedInterfaceOrientations", value: ["UIInterfaceOrientationPortrait"] },
      {
        key: "UISupportedInterfaceOrientations~ipad",
        value: ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown"]
      },
      { key: "UIRequiresFullScreen", value: true }
    ]);
  });

  it("locks both devices to the two landscape sides and asks for full screen", () => {
    const landscape = [
      "UIInterfaceOrientationLandscapeLeft",
      "UIInterfaceOrientationLandscapeRight"
    ];

    expect(orientationPlist("landscape")).toEqual([
      { key: "UISupportedInterfaceOrientations", value: landscape },
      { key: "UISupportedInterfaceOrientations~ipad", value: landscape },
      { key: "UIRequiresFullScreen", value: true }
    ]);
  });

  it.each(["any", undefined] as const)("leaves the template's orientations alone for %s", value => {
    expect(orientationPlist(value)).toEqual([]);
  });
});

describe("orientationManifest", () => {
  it.each([
    ["portrait", "portrait"],
    ["landscape", "sensorLandscape"]
  ] as const)("sets android:screenOrientation for %s to %s", (orientation, screenOrientation) => {
    expect(orientationManifest(orientation)).toEqual([
      { kind: "activity-attribute", name: "android:screenOrientation", value: screenOrientation }
    ]);
  });

  it.each([
    "any",
    undefined
  ] as const)("asks for android:screenOrientation to be absent for %s", orientation => {
    expect(orientationManifest(orientation)).toEqual([
      { kind: "activity-attribute", name: "android:screenOrientation", value: undefined }
    ]);
  });
});
