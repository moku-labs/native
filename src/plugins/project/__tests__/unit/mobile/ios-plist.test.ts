import { describe, expect, it } from "vitest";

import { removePlistKeys } from "../../../mobile/ios-plist";
import { CLEAN_INFO_PLIST, DEBUG_INFO_PLIST } from "./fixtures";

/** The keys the iOS patch pass removes, spelled out: the test must not share the source's list. */
const DEBUG_KEYS = ["NSLocalNetworkUsageDescription", "NSAppTransportSecurity"];

/** A plist whose root `<dict>` holds the given body lines. */
const plist = (body: readonly string[], lineEnding = "\n") =>
  ["<plist>", "<dict>", ...body, "</dict>", "</plist>", ""].join(lineEnding);

/** The key that stays beside every removed entry below. */
const NEIGHBOUR = ["\t<key>UIRequiresFullScreen</key>", "\t<true/>"];

describe("removePlistKeys", () => {
  it("drops both debug keys with their values, every other byte kept (bug: a store build ships the loosened ATS after a debug build of the same projectDir)", () => {
    expect(removePlistKeys(DEBUG_INFO_PLIST, DEBUG_KEYS)).toBe(CLEAN_INFO_PLIST);
  });

  it("removes a nested dict whole, walking its depth (bug: the first </dict> ends the value, and Xcode refuses the broken plist)", () => {
    const nested = [
      "\t<key>NSAppTransportSecurity</key>",
      "\t<dict>",
      "\t\t<key>NSExceptionDomains</key>",
      "\t\t<dict>",
      "\t\t\t<key>example.com</key>",
      "\t\t\t<dict>",
      "\t\t\t\t<key>NSIncludesSubdomains</key>",
      "\t\t\t\t<true/>",
      "\t\t\t</dict>",
      "\t\t</dict>",
      "\t\t<key>NSAllowsLocalNetworking</key>",
      "\t\t<true/>",
      "\t</dict>"
    ];

    expect(removePlistKeys(plist([...nested, ...NEIGHBOUR]), DEBUG_KEYS)).toBe(plist(NEIGHBOUR));
  });

  it("removes a self-closed <dict/> and nothing after it (bug: an empty dict never closes, the keys after it go too)", () => {
    const empty = ["\t<key>NSAppTransportSecurity</key>", "\t<dict/>"];

    expect(removePlistKeys(plist([...empty, ...NEIGHBOUR]), DEBUG_KEYS)).toBe(plist(NEIGHBOUR));
  });

  it("keeps CRLF line endings (bug: a Windows-edited file churns on every build)", () => {
    const entry = ["\t<key>NSLocalNetworkUsageDescription</key>", "\t<string>why</string>"];

    expect(removePlistKeys(plist([...entry, ...NEIGHBOUR], "\r\n"), DEBUG_KEYS)).toBe(
      plist(NEIGHBOUR, "\r\n")
    );
  });

  it("gives content without the keys back byte for byte (bug: every build rewrites the file)", () => {
    expect(removePlistKeys(CLEAN_INFO_PLIST, DEBUG_KEYS)).toBe(CLEAN_INFO_PLIST);
  });

  it("cuts an entry that shares its line with a neighbour, and only the entry (bug: a whole line goes, the neighbour with it)", () => {
    const oneLine =
      "<dict><key>NSLocalNetworkUsageDescription</key><string>why</string><key>Kept</key><true/></dict>";

    expect(removePlistKeys(oneLine, DEBUG_KEYS)).toBe("<dict><key>Kept</key><true/></dict>");
  });

  it("finds the root key behind a same-named key in a game's dict (bug: the first hit is the nested one, and the root ATS stays in a store build)", () => {
    const body = [
      "\t<key>GameSettings</key>",
      "\t<dict>",
      "\t\t<key>NSAppTransportSecurity</key>",
      "\t\t<true/>",
      "\t</dict>",
      "\t<key>NSAppTransportSecurity</key>",
      "\t<dict/>"
    ];

    expect(removePlistKeys(plist(body), DEBUG_KEYS)).toBe(
      plist(["\t<key>GameSettings</key>", "\t<dict>", "\t</dict>"])
    );
  });

  it.each([
    ["the end of the file", "<dict>\n\t<key>NSAppTransportSecurity</key>\n"],
    ["the closing tag of the dict around it", plist(["\t<key>NSAppTransportSecurity</key>"])],
    [
      "another key",
      plist(["\t<key>NSAppTransportSecurity</key>", "\t<key>Neighbour</key>", "\t<true/>"])
    ]
  ])("refuses a key followed by %s (bug: the root </dict> taken for the value, or the key left in a store build)", (_case, broken) => {
    expect(() => removePlistKeys(broken, DEBUG_KEYS)).toThrow(
      "[native] Could not find the value of NSAppTransportSecurity in Info.plist."
    );
  });
});
