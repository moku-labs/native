/**
 * @file project plugin — write-if-changed content-hash writer.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_SEGMENTS = new Set(["target", ".gradle", "DerivedData", "Pods"]);

/**
 * Guards codegen writes twice over.
 *
 * First, containment: a generator only ever writes INSIDE `projectDir`, so a path whose
 * relative form is empty, escapes with `..`, or is absolute (a different Windows drive)
 * is refused outright — that is the shape a traversal in a generated filename would take.
 *
 * Second, derived output: Cargo's `target/`, Gradle's `.gradle/`, Xcode's `DerivedData`
 * and CocoaPods' `Pods` are managed by `tauri build` (the `tauri` plugin), never by this
 * write-if-changed writer. Only the path BELOW `projectDir` is scanned for them: a
 * repository that happens to live under a directory called `target` (or `Pods`) is a
 * perfectly normal checkout, and refusing to write there would break that consumer.
 *
 * @param filePath - The path a generator wants to write.
 * @param projectDirectory - The Tauri project root the path is scanned relative to.
 * @throws {Error} When the path is outside `projectDir`, or contains a forbidden
 *   derived-output segment below it.
 * @example
 * ```ts
 * assertWritablePath("/repo/.moku/tauri/src-tauri/tauri.conf.json", "/repo/.moku/tauri"); // ok
 * assertWritablePath("/repo/.moku/tauri/src-tauri/target/debug/x", "/repo/.moku/tauri"); // throws
 * ```
 */
export function assertWritablePath(filePath: string, projectDirectory: string): void {
  const resolved = path.resolve(filePath);
  const relative = path.relative(path.resolve(projectDirectory), resolved);

  const escapesProject =
    relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`);
  if (escapesProject || path.isAbsolute(relative)) {
    throw new Error(
      `[native] Refusing to write outside projectDir: ${resolved}.\n  Generators only write files below config.projectDir — check the path this generator built.`
    );
  }

  const segments = new Set(relative.split(path.sep));
  const hit = [...FORBIDDEN_SEGMENTS].find(segment => segments.has(segment));
  if (hit) {
    throw new Error(
      `[native] Refusing to write generated content into derived directory "${hit}".\n  Generators only own pure project files — "tauri build" owns ${hit}/.`
    );
  }
}

/**
 * Hashes file content with SHA-256 for stateless content-equality comparison. Text is
 * hashed as UTF-8 bytes, so a string and the bytes it encodes to compare equal.
 *
 * @param content - The text or bytes to hash.
 * @returns A hex-encoded SHA-256 digest.
 * @example
 * ```ts
 * hashOf("hello"); // a 64-char hex SHA-256 digest
 * ```
 */
function hashOf(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads a file's raw bytes, treating a missing file as "no existing content" rather
 * than a thrown error.
 *
 * @param filePath - The path to read.
 * @returns The file bytes, or undefined when the file does not exist.
 * @example
 * ```ts
 * const existing = await readExisting("/repo/.moku/tauri/src-tauri/tauri.conf.json");
 * ```
 */
async function readExisting(filePath: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Writes `content` to `filePath` only when it differs from the file already on disk.
 * The on-disk file is hashed at write time (stateless diff — no in-memory hash cache),
 * and unchanged content is never rewritten, which preserves mtime and keeps Cargo's
 * incremental build cache warm. Text and binary content (the placeholder icon) both go
 * through this one entry point.
 *
 * @param filePath - The absolute path to write.
 * @param content - The desired file content, as text or raw bytes.
 * @param projectDirectory - The Tauri project root, for the derived-directory guard.
 * @returns `"written"` when the file was created/updated, `"unchanged"` when identical
 *   content was already on disk.
 * @throws {Error} When `filePath` is outside `projectDir` or targets a derived/build-output
 *   directory below it.
 * @example
 * ```ts
 * const action = await writeIfChanged(confPath, json, "/repo/.moku/tauri");
 * ```
 */
export async function writeIfChanged(
  filePath: string,
  content: string | Uint8Array,
  projectDirectory: string
): Promise<"written" | "unchanged"> {
  assertWritablePath(filePath, projectDirectory);

  const existing = await readExisting(filePath);
  if (existing !== undefined && hashOf(existing) === hashOf(content)) {
    return "unchanged";
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return "written";
}
