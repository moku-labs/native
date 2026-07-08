/**
 * @file tauri plugin — exit-code/stderr error taxonomy (pure classifier).
 *
 * `classify` never touches raw (unscrubbed) stderr — callers must scrub first
 * (scrub.ts) so a classified {@link TauriError}'s `stderrTail` is always safe
 * to log/display.
 */
import { TauriError, type TauriErrorKind } from "./types";

/** How many trailing lines of scrubbed stderr are kept on a classified error. */
const STDERR_TAIL_LINES = 20;

/** Ordered (most-specific-first) taxonomy patterns matched against scrubbed stderr. */
const TAXONOMY_PATTERNS: ReadonlyArray<{ kind: TauriErrorKind; test: RegExp }> = [
  {
    kind: "signing-failed",
    test: /codesign|provisioning profile|keychain|signtool|jarsigner|keystore/i
  },
  {
    kind: "toolchain-missing",
    test: /command not found|xcode-select|android_home|ndk (not found|is not installed)|rustup|cargo: not found/i
  },
  {
    kind: "device-unavailable",
    test: /no devices found|device not found|simulator (not booted|not found)|no emulators found|adb: no devices/i
  },
  {
    kind: "config-invalid",
    test: /tauri\.conf|failed to parse .*config|invalid config|schema validation failed/i
  },
  {
    kind: "compile-failed",
    test: /error\[e\d+\]|could not compile|compilation failed/i
  }
];

/** Actionable suggestion text per taxonomy bucket (second line of the `[native]` message). */
const ADVICE: Record<TauriErrorKind, string> = {
  "signing-failed":
    "Check your signing configuration (certificates/keystore/keychain) and run `native doctor`.",
  "toolchain-missing":
    "Install the missing platform toolchain, then run `native doctor` to confirm.",
  "device-unavailable": "Connect a device or start a simulator/emulator, then retry.",
  "config-invalid": "Check the generated `tauri.conf.json` for syntax/schema errors.",
  "compile-failed": "Inspect the compile errors above; fix the source and retry.",
  cancelled: "The command was cancelled or terminated before completion.",
  unknown: "Inspect the stderr tail above; run `native doctor` if the cause is unclear."
};

/**
 * Classifies a non-zero tauri CLI exit into a {@link TauriError}.
 *
 * @param code - Process exit code (`null` when signal-terminated).
 * @param scrubbedStderr - Already-scrubbed stderr (see scrub.ts) — never raw output.
 * @returns A {@link TauriError} carrying the taxonomy bucket and a scrubbed stderr tail.
 * @example
 * ```ts
 * throw classify(101, scrub(rawStderr));
 * ```
 */
export function classify(code: number | null, scrubbedStderr: string): TauriError {
  const match = TAXONOMY_PATTERNS.find(({ test }) => test.test(scrubbedStderr));
  const kind: TauriErrorKind = match?.kind ?? (code === null ? "cancelled" : "unknown");
  const stderrTail = tailLines(scrubbedStderr, STDERR_TAIL_LINES);
  const message = `[native] tauri ${kind.replaceAll("-", " ")}.\n  ${ADVICE[kind]}`;
  return new TauriError(kind, message, { exitCode: code, stderrTail });
}

/**
 * Keeps only the last `maxLines` non-empty lines of `text`.
 *
 * @param text - Full (already-scrubbed) text.
 * @param maxLines - Maximum number of trailing lines to keep.
 * @returns The trailing lines, joined with `\n`.
 * @example
 * ```ts
 * tailLines(scrubbedStderr, 20);
 * ```
 */
function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  return lines.slice(-maxLines).join("\n");
}
