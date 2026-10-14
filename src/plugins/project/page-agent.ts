/**
 * @file project plugin — page agent detection: scans the built web dist for the editor
 * agent's marker strings, so a store build of a page that still carries the agent is refused.
 */

/** What {@link detectPageAgent} found: the agent and the first file that carries it, or nothing. */
export type PageAgentResult = { agent: true; file: string } | { agent: false };

/**
 * Scans every `.js` file under the dist directory for the editor agent's marker strings.
 *
 * @param _options - Where the dist lives.
 * @param _options.root - The web project root (`web.cwd ?? cwd`).
 * @param _options.dist - The dist directory, relative to `root`.
 * @example
 * ```ts
 * await detectPageAgent({ root: ".", dist: "dist" }); // { agent: false }
 * ```
 */
export async function detectPageAgent(_options: {
  root: string;
  dist: string;
}): Promise<PageAgentResult> {
  throw new Error("not implemented");
}
