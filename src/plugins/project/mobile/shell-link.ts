/**
 * @file project plugin — the shell linkage check: `gen/android/tauri.settings.gradle` must
 * name `moku-shell`, or every `__MOKU_NATIVE__` call fails at runtime with no build error.
 */

/**
 * Fails with a `[native]` error when the shell plugin is not linked into `gen/android`.
 *
 * @param _options - Where to look.
 * @param _options.genDirectory - Absolute `src-tauri/gen/android` path.
 * @example
 * ```ts
 * await assertShellLinked({ genDirectory });
 * ```
 */
export async function assertShellLinked(_options: { genDirectory: string }): Promise<void> {
  throw new Error("not implemented");
}
