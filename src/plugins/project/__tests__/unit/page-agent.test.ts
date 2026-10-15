import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectPageAgent } from "../../page-agent";

describe("detectPageAgent", () => {
  let root: string;
  let dist: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "moku-native-page-agent-"));
    dist = path.join(root, "dist");
    await mkdir(path.join(dist, "page"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<script src=page/main.js></script>", "utf8");
    await writeFile(path.join(dist, "page", "app.js"), "console.log('game');\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Writes one file below the dist directory. */
  const distFile = (relative: string, content: string) =>
    writeFile(path.join(dist, relative), content, "utf8");

  /** Scans the fixture's dist. */
  const scan = () => detectPageAgent({ root, dist: "dist" });

  it('finds "/__editor/hello" in a nested .js and names that file (bug: an agent page shipped to the store)', async () => {
    await distFile("page/main-4f2a.js", 'fetch("/__editor/hello");\n');

    expect(await scan()).toEqual({ agent: true, file: "page/main-4f2a.js" });
  });

  it('finds "[moku-editor]" alone', async () => {
    await distFile("agent.js", 'console.info("[moku-editor] connected");\n');

    expect(await scan()).toEqual({ agent: true, file: "agent.js" });
  });

  it("reports no agent for a clean dist (bug: every game refused)", async () => {
    expect(await scan()).toEqual({ agent: false });
  });

  it("reports no agent when the dist does not exist", async () => {
    expect(await detectPageAgent({ root, dist: "missing" })).toEqual({ agent: false });
  });

  it("ignores the strings in .map and .html files (bug: a false refusal from a source map)", async () => {
    await distFile(
      "page/app.js.map",
      String.raw`{"sourcesContent":["fetch(\"/__editor/hello\")"]}`
    );
    await distFile("editor.html", "<p>[moku-editor]</p>");

    expect(await scan()).toEqual({ agent: false });
  });

  it("does not follow a symlink out of the dist (bug: a file outside the page refuses the build)", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "editor.js"), 'fetch("/__editor/hello");\n', "utf8");
    await symlink(path.join(outside, "editor.js"), path.join(dist, "linked.js"));
    await symlink(outside, path.join(dist, "linked-folder"));

    expect(await scan()).toEqual({ agent: false });
  });

  it("follows a link inside the dist and stops at a link loop (bug: an agent chunk behind a link ships, or the scan never ends)", async () => {
    await mkdir(path.join(dist, "assets"));
    await writeFile(path.join(dist, "assets", "editor.txt"), "[moku-editor] ready\n", "utf8");
    await symlink(path.join(dist, "page"), path.join(dist, "page", "a-loop"));
    await symlink(path.join(dist, "assets", "editor.txt"), path.join(dist, "page", "agent.js"));

    expect(await scan()).toEqual({ agent: true, file: "page/agent.js" });
  });
});
