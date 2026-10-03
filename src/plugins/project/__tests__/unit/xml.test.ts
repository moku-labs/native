import { describe, expect, it } from "vitest";

import { escapeXml } from "../../xml";

describe("escapeXml", () => {
  it("writes the five XML special characters as entities", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  it("escapes an ampersand exactly once, so an entity is never doubled", () => {
    expect(escapeXml("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("returns plain text untouched", () => {
    expect(escapeXml("UIInterfaceOrientationPortrait")).toBe("UIInterfaceOrientationPortrait");
  });
});
