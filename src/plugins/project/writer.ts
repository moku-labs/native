/**
 * @file project plugin — write-if-changed content-hash writer.
 */
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
 * @param filePath - The path a generator wants to write.
 * @throws {Error} When the path contains a forbidden derived-output segment.
 * @example
 * ```ts
 * assertWritablePath("/repo/.moku/tauri/src-tauri/tauri.conf.json"); // ok
 * assertWritablePath("/repo/.moku/tauri/src-tauri/target/debug/x"); // throws
 * ```
 */
export function assertWritablePath(filePath: string): void {
  const segments = new Set(filePath.split(path.sep));
  const hit = [...FORBIDDEN_SEGMENTS].find(segment => segments.has(segment));
  if (hit) {
    throw new Error(
      `[native] Refusing to write generated content into derived directory "${hit}".\n  Generators only own pure project files — "tauri build" owns ${hit}/.`
    );
  }
}

/**
 * Hashes UTF-8 text content with SHA-256 for stateless content-equality comparison.
 *
 * @param content - The text to hash.
 * @returns A hex-encoded SHA-256 digest.
 * @example
 * ```ts
 * hashOf("hello"); // a 64-char hex SHA-256 digest
 * ```
 */
function hashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Reads a file's content, treating a missing file as "no existing content" rather
 * than a thrown error.
 *
 * @param filePath - The path to read.
 * @returns The file content, or undefined when the file does not exist.
 * @example
 * ```ts
 * const existing = await readExisting("/repo/.moku/tauri/src-tauri/tauri.conf.json");
 * ```
 */
async function readExisting(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Writes `content` to `filePath` only when it differs from the file already on disk.
 * The on-disk file is hashed at write time (stateless diff — no in-memory hash cache),
 * and unchanged content is never rewritten, which preserves mtime and keeps Cargo's
 * incremental build cache warm.
 *
 * @param filePath - The absolute path to write.
 * @param content - The desired file content.
 * @returns `"written"` when the file was created/updated, `"unchanged"` when identical
 *   content was already on disk.
 * @throws {Error} When `filePath` targets a derived/build-output directory.
 * @example
 * ```ts
 * const action = await writeIfChanged("/repo/.moku/tauri/src-tauri/tauri.conf.json", json);
 * ```
 */
export async function writeIfChanged(
  filePath: string,
  content: string
): Promise<"written" | "unchanged"> {
  assertWritablePath(filePath);

  const existing = await readExisting(filePath);
  if (existing !== undefined && hashOf(existing) === hashOf(content)) {
    return "unchanged";
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return "written";
}
