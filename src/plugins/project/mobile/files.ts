/**
 * @file project plugin — the ONE owner of "which generated files a mobile patch pass may
 * touch". Every iOS patch (the runner-command rewrite, the Xcode build-settings patch and
 * the iOS project patches) reads the same list from here, so none can drift into a file the
 * others do not know about — and none ever descends into `gen/apple/build` or
 * `gen/android/build`, which belong to the toolchain. The privacy manifest's place in the
 * tree is here too, and so is the app's `Info.plist`. The Android status bar patch finds its
 * MainActivity.kt here, the profile patches their `strings.xml` and network security config,
 * and the icon inset its adaptive icon directory.
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

/** Where `tauri android init` writes the app's resources, below `gen/android`. */
const ANDROID_RESOURCE_SEGMENTS = ["app", "src", "main", "res"];

/** Derived directories a patch scan never descends into — the toolchain owns them. */
const SKIPPED_DIRECTORIES = new Set(["build", ".gradle", ".idea"]);

/** The file name Apple reads a privacy manifest from, at the top of the app bundle. */
export const IOS_PRIVACY_MANIFEST_FILE = "PrivacyInfo.xcprivacy";

/** How the directory of the app's own files ends in `gen/apple`: `<slug>_iOS`. */
const IOS_APP_DIRECTORY_SUFFIX = "_iOS";

/** The file name of the app's property list, in that directory. */
export const IOS_INFO_PLIST_FILE = "Info.plist";

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
 * Lists the `Info.plist` of the generated iOS app, the file `tauri ios build` merges the
 * sidecar into: in the `gen/apple` directory that ends in `_iOS`. A tree where tauri has not
 * written it yet lists nothing.
 *
 * @param genDirectory - The `src-tauri/gen/apple` directory.
 * @returns The existing files, possibly none.
 * @example
 * ```ts
 * await iosInfoPlistFiles("/repo/.moku/tauri/src-tauri/gen/apple");
 * // ["/repo/.moku/tauri/src-tauri/gen/apple/my-game_iOS/Info.plist"]
 * ```
 */
export async function iosInfoPlistFiles(genDirectory: string): Promise<string[]> {
  const entries = await readdir(genDirectory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.endsWith(IOS_APP_DIRECTORY_SUFFIX))
    .map(entry => path.join(genDirectory, entry.name, IOS_INFO_PLIST_FILE))
    .filter(file => existsSync(file));
}

/**
 * Returns where the iOS patch pass keeps the privacy manifest: the top of `gen/apple`, the
 * directory `project.yml` and the pbxproj's root group resolve a relative path from.
 *
 * @param genDirectory - The `src-tauri/gen/apple` directory.
 * @returns The `PrivacyInfo.xcprivacy` path of that tree.
 * @example
 * ```ts
 * iosPrivacyManifestPath("/repo/.moku/tauri/src-tauri/gen/apple");
 * // "/repo/.moku/tauri/src-tauri/gen/apple/PrivacyInfo.xcprivacy"
 * ```
 */
export function iosPrivacyManifestPath(genDirectory: string): string {
  return path.join(genDirectory, IOS_PRIVACY_MANIFEST_FILE);
}

/**
 * Walks a directory tree collecting accepted files, skipping derived build output.
 *
 * @param directory - The directory to walk (a missing directory yields nothing).
 * @param accept - Predicate over the file name.
 * @returns Every accepted file path below `directory`.
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

/**
 * Returns the directory `tauri android init` writes the app's resources into, where the
 * window background patch finds every `values*\/themes.xml`.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The `app/src/main/res` directory of that tree.
 * @example
 * ```ts
 * androidResourceDirectory("/repo/.moku/tauri/src-tauri/gen/android");
 * // "/repo/.moku/tauri/src-tauri/gen/android/app/src/main/res"
 * ```
 */
export function androidResourceDirectory(genDirectory: string): string {
  return path.join(genDirectory, ...ANDROID_RESOURCE_SEGMENTS);
}

/**
 * Returns the app's string resources, where the debug profile renames the app.
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The `res/values/strings.xml` path of that tree.
 * @example
 * ```ts
 * androidStringsPath("/repo/.moku/tauri/src-tauri/gen/android");
 * // "/repo/.moku/tauri/src-tauri/gen/android/app/src/main/res/values/strings.xml"
 * ```
 */
export function androidStringsPath(genDirectory: string): string {
  return path.join(genDirectory, ...ANDROID_RESOURCE_SEGMENTS, "values", "strings.xml");
}

/**
 * Returns the network security config the debug profile writes and the store profile
 * deletes again (only when it carries the moku marker).
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The `res/xml/network_security_config.xml` path of that tree.
 * @example
 * ```ts
 * androidNetworkConfigPath("/repo/.moku/tauri/src-tauri/gen/android");
 * // "/repo/.moku/tauri/src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml"
 * ```
 */
export function androidNetworkConfigPath(genDirectory: string): string {
  return path.join(
    genDirectory,
    ...ANDROID_RESOURCE_SEGMENTS,
    "xml",
    "network_security_config.xml"
  );
}

/**
 * Returns the directory `tauri icon` writes the adaptive launcher icons into
 * (`ic_launcher.xml`, `ic_launcher_round.xml`).
 *
 * @param genDirectory - The `src-tauri/gen/android` directory.
 * @returns The `res/mipmap-anydpi-v26` directory of that tree.
 * @example
 * ```ts
 * androidAdaptiveIconDirectory("/repo/.moku/tauri/src-tauri/gen/android");
 * // "/repo/.moku/tauri/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26"
 * ```
 */
export function androidAdaptiveIconDirectory(genDirectory: string): string {
  return path.join(genDirectory, ...ANDROID_RESOURCE_SEGMENTS, "mipmap-anydpi-v26");
}
