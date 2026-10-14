/**
 * @file doctor plugin check — the Android debug keystore a debug build is signed with.
 * Missing is a warning: a store build does not need it.
 */
import path from "node:path";
import type { CheckResult } from "../types";
import type { Check, CheckInput } from "./types";

/** How a signed debug build reaches a device — the pass message names both ways. */
const INSTALL_STEPS =
  "install a debug build over a cable with `adb install -r <apk>`, or over Wi-Fi (Android 11+) with `adb pair <ip>:<pair-port>` then `adb connect <ip>:<port>`";

/**
 * The commands that create the standard Android debug keystore: `mkdir -p` first, since
 * `keytool` does not create parent directories. Doctor only reports them; it never runs
 * them. With no known home the paths stay unquoted `~/…`, so the shell still expands `~`.
 *
 * @param home - The home directory, or `undefined` when the env names none.
 * @returns The command line.
 * @example
 * ```ts
 * keytoolCommand("/home/me"); // 'mkdir -p "/home/me/.android" && keytool -genkeypair -v -keystore "/home/me/.android/debug.keystore" …'
 * ```
 */
function keytoolCommand(home: string | undefined): string {
  const directory = home === undefined ? "~/.android" : `"${path.join(home, ".android")}"`;
  const keystore =
    home === undefined
      ? "~/.android/debug.keystore"
      : `"${path.join(home, ".android", "debug.keystore")}"`;
  return `mkdir -p ${directory} && keytool -genkeypair -v -keystore ${keystore} -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"`;
}

/**
 * Looks for `<home>/.android/debug.keystore` (home is `HOME`, else `USERPROFILE`).
 * Warn-only: a store build signs with its own keystore.
 *
 * @param input - The check input, scoped to the "android" target.
 * @returns The check result — "pass" or "warn", never "fail".
 * @example
 * ```ts
 * await run({ target: "android", env, fs, ... });
 * ```
 */
async function run(input: CheckInput): Promise<CheckResult> {
  const home = input.env.get("HOME") ?? input.env.get("USERPROFILE");
  const keystore = home === undefined ? undefined : path.join(home, ".android", "debug.keystore");

  if (keystore === undefined || !(await input.fs.exists(keystore))) {
    const location = keystore ?? "~/.android/debug.keystore";
    return {
      id: "android-debug-signing",
      target: "android",
      status: "warn",
      message: `[native] no Android debug keystore at ${location}, so debug builds cannot be signed (a store build does not need it).`,
      fixIt: keytoolCommand(home)
    };
  }

  return {
    id: "android-debug-signing",
    target: "android",
    status: "pass",
    message: `[native] Android debug keystore found at ${keystore}; ${INSTALL_STEPS}.`
  };
}

/** The Android debug keystore — android only, warn-only. */
export const androidDebugSigningCheck: Check = {
  id: "android-debug-signing",
  /**
   * Whether this check applies — android only.
   *
   * @param target - The candidate scope.
   * @returns Whether `android-debug-signing` applies to `target`.
   * @example
   * ```ts
   * androidDebugSigningCheck.appliesTo("android", global); // true
   * ```
   */
  appliesTo: target => target === "android",
  run
};
