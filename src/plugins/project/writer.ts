/**
 * @file project plugin — write-if-changed content-hash writer.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_SEGMENTS = new Set(["target", ".gradle", "DerivedData", "Pods"]);

/**
 * Guards codegen writes against derived/build-output directories that generators must
 * never touch — Cargo's `target/`, Gradle's `.gradle/`, Xcode's `DerivedData`, and
 * CocoaPods' `Pods` are all managed by `tauri build` (the `tauri` plugin), not by this
 * write-if-changed writer.
 *
 * Only the path BELOW `projectDir` is scanned: a repository that happens to live under a
 * directory called `target` (or `Pods`) is a perfectly normal checkout, and refusing to
 * write there would break the whole plugin for that consumer.
 *
 * @param filePath - The path a generator wants to write.
 * @param projectDirectory - The Tauri project root the path is scanned relative to.
 * @throws {Error} When the path contains a forbidden derived-output segment below `projectDir`.
 * @example
 * ```ts
 * assertWritablePath("/repo/.moku/tauri/src-tauri/tauri.conf.json", "/repo/.moku/tauri"); // ok
 * assertWritablePath("/repo/.moku/tauri/src-tauri/target/debug/x", "/repo/.moku/tauri"); // throws
 * ```
 */
export function assertWritablePath(filePath: string, projectDirectory: string): void {
  const relative = path.relative(path.resolve(projectDirectory), path.resolve(filePath));
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
 * @throws {Error} When `filePath` targets a derived/build-output directory below `projectDir`.
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
