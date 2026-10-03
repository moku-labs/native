/**
 * @file project plugin — the ONE owner of "which generated files a mobile patch pass may
 * touch". Both iOS patches (the runner-command rewrite and the Xcode build-settings patch)
 * read the same list from here, so neither can drift into a file the other does not know
 * about — and neither ever descends into `gen/apple/build` or `gen/android/build`, which
 * belong to the toolchain. The Android status bar patch finds its MainActivity.kt here too.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** Source extensions that can carry the Android runner command. */
const ANDROID_SOURCE_EXTENSIONS = new Set([".kt", ".kts", ".gradle"]);

/** The Kotlin file `tauri android init` writes the app's activity into. */
const MAIN_ACTIVITY_FILE = "MainActivity.kt";

/** Where `tauri android init` writes the app's Kotlin sources, below `gen/android`. */
const ANDROID_JAVA_SEGMENTS = ["app", "src", "main", "java"];

/** Derived directories a patch scan never descends into — the toolchain owns them. */
const SKIPPED_DIRECTORIES = new Set(["build", ".gradle", ".idea"]);

/**
 * Lists the generated iOS files a patch pass may rewrite: `project.yml` plus the
 * `project.pbxproj` of every generated Xcode project. `gen/apple/build` is never listed —
 * that tree is `xcodebuild` output, not project source.
 *
 * @param genDirectory - The `src-tauri/gen/apple` directory.
 * @returns The existing files to patch.
 * @example
 * ```ts
 * await iosPatchFiles("/repo/.moku/tauri/src-tauri/gen/apple");
 * ```
 */
export async function iosPatchFiles(genDirectory: string): Promise<string[]> {
  const files: string[] = [];

  const projectYml = path.join(genDirectory, "project.yml");
  if (existsSync(projectYml)) files.push(projectYml);

  for (const entry of await readdir(genDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".xcodeproj")) continue;
    const pbxproj = path.join(genDirectory, entry.name, "project.pbxproj");
    if (existsSync(pbxproj)) files.push(pbxproj);
  }

  return files;
}

/**
 * Walks a directory tree collecting accepted files, skipping derived build output.
 *
 * @param directory - The directory to walk (a missing directory yields nothing).
 * @param accept - Predicate over the file name.
 * @returns Every accepted file path below `directory`.
 * @example
 * ```ts
 * await collectFiles(buildSrcDirectory, name => name.endsWith(".kt"));
 * ```
 */
async function collectFiles(
  directory: string,
  accept: (name: string) => boolean
): Promise<string[]> {
  if (!existsSync(directory)) return [];

  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await collectFiles(full, accept)));
      continue;
    }
    if (accept(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Lists the generated Android files a patch pass may rewrite: every Kotlin/Gradle source
 * under `buildSrc`, plus the two top-level Gradle build files.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The existing files to patch.
 * @example
 * ```ts
 * await androidPatchFiles("/repo/.moku/tauri/src-tauri/gen/android");
 * ```
 */
export async function androidPatchFiles(genDirectory: string): Promise<string[]> {
  const buildSource = await collectFiles(path.join(genDirectory, "buildSrc"), name =>
    ANDROID_SOURCE_EXTENSIONS.has(path.extname(name))
  );
  const gradleFiles = [
    path.join(genDirectory, "build.gradle.kts"),
    path.join(genDirectory, "app", "build.gradle.kts")
  ].filter(file => existsSync(file));

  return [...buildSource, ...gradleFiles];
}

/**
 * Returns the directory `tauri android init` writes the app's Kotlin sources into. The
 * MainActivity.kt sits below it, in a folder per segment of the app identifier.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The `app/src/main/java` directory of that tree.
 * @example
 * ```ts
 * androidJavaDirectory("/repo/.moku/tauri/src-tauri/gen/android");
 * // "/repo/.moku/tauri/src-tauri/gen/android/app/src/main/java"
 * ```
 */
export function androidJavaDirectory(genDirectory: string): string {
  return path.join(genDirectory, ...ANDROID_JAVA_SEGMENTS);
}

/**
 * Lists every `MainActivity.kt` below `app/src/main/java`, sorted by path. Build output is
 * never listed. A generated tree holds exactly one; the caller decides what more or fewer
 * means.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The MainActivity.kt paths found, possibly none.
 * @example
 * ```ts
 * await androidMainActivityFiles("/repo/.moku/tauri/src-tauri/gen/android");
 * // ["/repo/.moku/tauri/src-tauri/gen/android/app/src/main/java/com/acme/demo/MainActivity.kt"]
 * ```
 */
export async function androidMainActivityFiles(genDirectory: string): Promise<string[]> {
  const found = await collectFiles(
    androidJavaDirectory(genDirectory),
    name => name === MAIN_ACTIVITY_FILE
  );
  return found.toSorted();
}
