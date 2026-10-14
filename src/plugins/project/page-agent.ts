/**
 * @file project plugin — page agent detection: scans the built web dist for the editor
 * agent's marker strings, so a store build of a page that still carries the agent is refused.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { toPosix } from "./generators/paths";
import type { PageAgentResult } from "./types";

/**
 * The two strings the engine's own release refusal looks for (moku_game
 * `.planning/specs/10-debug-build.md` §R): the agent's handshake route and its log prefix.
 * Either one in a shipped script means the editor agent ships with the page.
 */
export const PAGE_AGENT_MARKERS = ["/__editor/hello", "[moku-editor]"] as const;

/** The one file type a page agent can run from — never a source map or an HTML file. */
const SCRIPT_EXTENSION = ".js";

/** What one directory entry is, once a symlink inside the dist is resolved. */
type EntryKind = "directory" | "script" | "other";

/** The walk's fixed context: the real dist root, and the real directories already walked. */
type Walk = { readonly realRoot: string; readonly visited: Set<string> };

/**
 * Resolves a path's real location, or nothing when it does not resolve (a dangling link).
 *
 * @param target - The path to resolve.
 * @returns The real path, or undefined.
 * @example
 * ```ts
 * await realPathOf("/app/dist/missing"); // undefined
 * ```
 */
async function realPathOf(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return;
  }
}

/**
 * Tells whether a real path sits strictly inside the real dist directory.
 *
 * @param realRoot - The dist directory, symlinks resolved.
 * @param real - The candidate's real path.
 * @returns True when `real` is below `realRoot`.
 * @example
 * ```ts
 * isInside("/app/dist", "/app/dist/page/main.js"); // true
 * isInside("/app/dist", "/app/outside/editor.js"); // false
 * ```
 */
function isInside(realRoot: string, real: string): boolean {
  const relative = path.relative(realRoot, real);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Classifies one directory entry. A symlink is followed only when its target is inside the
 * dist, and a directory reached twice (a link back up the tree) is not walked again.
 *
 * @param entry - The directory entry.
 * @param full - Its path.
 * @param walk - The real dist root and the directories already walked.
 * @returns What the entry is for the scan.
 * @example
 * ```ts
 * await entryKind(entry, "/app/dist/page", { realRoot: "/app/dist", visited }); // "directory"
 * ```
 */
async function entryKind(entry: Dirent, full: string, walk: Walk): Promise<EntryKind> {
  const isScript = entry.name.endsWith(SCRIPT_EXTENSION);
  if (!entry.isSymbolicLink()) {
    if (entry.isDirectory()) return "directory";
    return entry.isFile() && isScript ? "script" : "other";
  }

  const real = await realPathOf(full);
  if (real === undefined || !isInside(walk.realRoot, real)) return "other";
  const target = await stat(real);
  if (target.isDirectory()) return walk.visited.has(real) ? "other" : "directory";
  return target.isFile() && isScript ? "script" : "other";
}

/**
 * Tells whether one script carries an agent marker. Files are read one at a time: a dist
 * can hold large bundles.
 *
 * @param file - The script's path.
 * @returns True when the script carries a marker.
 * @example
 * ```ts
 * await carriesAgent("/app/dist/page/main-4f2a.js"); // true
 * ```
 */
async function carriesAgent(file: string): Promise<boolean> {
  const content = await readFile(file, "utf8");
  return PAGE_AGENT_MARKERS.some(marker => content.includes(marker));
}

/**
 * Walks one directory in name order and returns the first script carrying a marker.
 *
 * @param directory - The directory to walk.
 * @param walk - The real dist root and the directories already walked.
 * @returns The first hit's path, or undefined when the tree is clean.
 * @example
 * ```ts
 * await findAgent("/app/dist", { realRoot: "/app/dist", visited: new Set() }); // "/app/dist/page/main-4f2a.js"
 * ```
 */
async function findAgent(directory: string, walk: Walk): Promise<string | undefined> {
  walk.visited.add(await realpath(directory));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(directory, entry.name);
    const kind = await entryKind(entry, full, walk);
    if (kind === "directory") {
      const hit = await findAgent(full, walk);
      if (hit !== undefined) return hit;
    } else if (kind === "script" && (await carriesAgent(full))) {
      return full;
    }
  }
  return undefined;
}

/**
 * Scans every `.js` file under the dist directory for the editor agent's marker strings
 * ({@link PAGE_AGENT_MARKERS}), as UTF-8, one file at a time, in name order. Symlinks are
 * followed only inside the dist. A missing dist is a page without the agent.
 *
 * @param options - Where the dist lives.
 * @param options.root - The web project root (`web.cwd ?? cwd`).
 * @param options.dist - The dist directory, relative to `root`.
 * @returns `{ agent: true, file }` (POSIX, relative to the dist) for the first hit, else `{ agent: false }`.
 * @example
 * ```ts
 * await detectPageAgent({ root: ".", dist: "dist" }); // { agent: false }
 * ```
 */
export async function detectPageAgent(options: {
  root: string;
  dist: string;
}): Promise<PageAgentResult> {
  const distDirectory = path.resolve(options.root, options.dist);
  const realRoot = await realPathOf(distDirectory);
  if (realRoot === undefined) return { agent: false };
  const root = await stat(realRoot);
  if (!root.isDirectory()) return { agent: false };

  const hit = await findAgent(distDirectory, { realRoot, visited: new Set() });
  if (hit === undefined) return { agent: false };
  return { agent: true, file: toPosix(path.relative(distDirectory, hit)) };
}
