/**
 * @file tauri plugin — exit-code/output error taxonomy (pure classifier).
 *
 * `classify` never touches raw (unscrubbed) output — callers must scrub first
 * (scrub.ts) so a classified {@link TauriError}'s `stderrTail` is always safe
 * to log/display. Callers pass BOTH streams: xcodebuild writes the real cause
 * to stdout and leaves stderr holding tauri's one-line wrapper.
 */
import type { TauriErrorDetails, TauriErrorKind } from "./types";

/**
 * Thrown by every one-shot verb (`icon`/`build`/`mobileInit`) on a non-zero exit.
 * Carries a classified {@link TauriErrorKind} and the scrubbed stderr tail so
 * callers (`build`, `doctor`, `cli`) can render an actionable message without
 * re-deriving the taxonomy or re-scrubbing raw output.
 */
export class TauriError extends Error implements TauriErrorDetails {
  readonly kind: TauriErrorKind;
  readonly exitCode: number | null;
  readonly stderrTail: string;

  /**
   * Constructs a classified `TauriError`.
   *
   * @param kind - Taxonomy bucket.
   * @param message - Fully formatted `[native] ...` message.
   * @param details - Exit code + scrubbed stderr tail.
   * @param details.exitCode - Raw process exit code (`null` when signal-terminated).
   * @param details.stderrTail - Scrubbed tail of stderr — already safe to log/display.
   * @example
   * ```ts
   * throw new TauriError("compile-failed", "[native] tauri compile failed.\n  See stderr.", {
   *   exitCode: 101,
   *   stderrTail: "error[E0432]: unresolved import `foo`",
   * });
   * ```
   */
  constructor(
    kind: TauriErrorKind,
    message: string,
    details: { exitCode: number | null; stderrTail: string }
  ) {
    super(message);
    this.name = "TauriError";
    this.kind = kind;
    this.exitCode = details.exitCode;
    this.stderrTail = details.stderrTail;
  }
}

/** How many trailing lines of scrubbed output are kept after the separator. */
const STDERR_TAIL_LINES = 10;

/** How many extracted cause lines are kept ahead of the separator. */
const SIGNAL_LINES = 15;

/** Marks where the extracted cause lines end and the raw trailing lines begin. */
const TAIL_SEPARATOR = "…";

/**
 * Lines the classifier ignores entirely. Every unsigned iOS simulator build prints
 * `Warn No code signing certificates found …`, which is harmless — matching it would
 * misclassify EVERY iOS failure as `signing-failed`.
 */
const IGNORED_LINE_PATTERN = /^\s*Warn\b/;

/**
 * Lines that carry a real cause. The only way to surface the actual error out of an
 * xcodebuild log, where the last lines are a destination list and the cause sits
 * hundreds of lines earlier — and the only lines the taxonomy is allowed to classify
 * over, so that an ordinary `CodeSign <path>` progress line cannot outrank them.
 *
 * Because it is the gate, it must admit every trigger {@link TAXONOMY_PATTERNS} keys on:
 * a bucket whose only realistic line is not a signal line is unreachable however well its
 * own pattern is written. `not booted` (device-unavailable) and `invalid config`
 * (config-invalid) announce themselves with neither an "error" nor a "failed".
 */
const SIGNAL_LINE_PATTERN =
  /\berror\b[: ]|^\s*Error\b|panicked|cannot find|not found|no \S+ found|not installed|not booted|invalid config|PhaseScriptExecution|failed/i;

/**
 * Lines that read like a cause but never are: Xcode dumps the whole build environment
 * as `export NAME=value`, and echoes `*_ERROR` / `WARNINGS_AS_ERRORS` build settings.
 */
const SIGNAL_NOISE_PATTERN = /_ERROR\b|WARNINGS_AS_ERRORS/;

/** Prefix of an Xcode environment-dump line — configuration, never a cause. */
const EXPORT_LINE_PREFIX = "export ";

/** Ordered (most-specific-first) taxonomy patterns matched against scrubbed output. */
const TAXONOMY_PATTERNS: ReadonlyArray<{ kind: TauriErrorKind; test: RegExp }> = [
  // Ahead of signing-failed and compile-failed on purpose: a failed "Build Rust Code"
  // phase is a runner/toolchain problem inside Xcode, and neither of those fix-its helps.
  {
    kind: "xcode-script-failed",
    test: /PhaseScriptExecution .*Build\\? Rust\\? Code/
  },
  {
    kind: "signing-failed",
    test: /codesign|no signing certificate|provisioning profile|notariz|keychain|signtool|jarsigner|keystore/i
  },
  {
    kind: "toolchain-missing",
    test: /command not found|xcode-select|android_home|ndk (not found|is not installed)|rustup|cargo: not found/i
  },
  // Before device-unavailable on purpose: a missing SDK platform reports BOTH
  // ("Found no destinations ... No devices found"), and only this fix-it helps.
  {
    kind: "platform-missing",
    test: /is not installed\. Please download and install the platform|Found no destinations/i
  },
  {
    kind: "device-unavailable",
    test: /no devices found|device not found|simulator (not booted|not found)|no emulators found|adb: no devices/i
  },
  // Anchored to a real failure verb: a bare `tauri.conf.json` mention appears in
  // ordinary progress output and must not be classified as a config error.
  {
    kind: "config-invalid",
    test: /failed to (parse|read) .*tauri\.conf|invalid config|schema validation failed/i
  },
  {
    kind: "compile-failed",
    test: /error\[e\d+\]|could not compile|compilation failed/i
  }
];

/** Actionable suggestion text per taxonomy bucket (second line of the `[native]` message). */
const ADVICE: Record<TauriErrorKind, string> = {
  "xcode-script-failed":
    'The Xcode "Build Rust Code" phase failed. Run `native clean --target ios`, rebuild, and check the runner line in gen/apple/project.yml.',
  "signing-failed":
    "Check your signing configuration (certificates/keystore/keychain) and run `native doctor`.",
  "toolchain-missing":
    "Install the missing platform toolchain, then run `native doctor` to confirm.",
  "platform-missing":
    "Install the SDK platform — for iOS run `xcodebuild -downloadPlatform iOS` — then run `native doctor`.",
  "device-unavailable": "Connect a device or start a simulator/emulator, then retry.",
  "config-invalid": "Check the generated `tauri.conf.json` for syntax/schema errors.",
  "compile-failed": "Inspect the compile errors above; fix the source and retry.",
  cancelled: "The command was cancelled or terminated before completion.",
  unknown: "Inspect the stderr tail above; run `native doctor` if the cause is unclear."
};

/**
 * Classifies a non-zero tauri CLI exit into a {@link TauriError}.
 *
 * Only CAUSE lines are classified (the same filter the tail builder uses): a 50k-line
 * xcodebuild log narrates `CodeSign <path>` and exports the whole keychain environment, and
 * one such incidental mention would otherwise decide the taxonomy for the entire build.
 *
 * @param code - Process exit code (`null` when signal-terminated).
 * @param scrubbedOutput - Already-scrubbed stdout + stderr (see scrub.ts) — never raw
 *   output, and never stderr alone: xcodebuild puts the cause on stdout.
 * @returns A {@link TauriError} carrying the taxonomy bucket and a scrubbed output tail.
 * @example
 * ```ts
 * throw classify(101, `${scrub(rawStdout)}\n${scrub(rawStderr)}`);
 * ```
 */
export function classify(code: number | null, scrubbedOutput: string): TauriError {
  const lines = scrubbedOutput.split(/\r?\n/).filter(line => line.length > 0);
  const classifiable = signalLines(lines);

  const match = TAXONOMY_PATTERNS.find(({ test }) => classifiable.some(line => test.test(line)));
  const kind: TauriErrorKind = match?.kind ?? (code === null ? "cancelled" : "unknown");
  const message = `[native] tauri ${kind.replaceAll("-", " ")}.\n  ${ADVICE[kind]}`;
  return new TauriError(kind, message, { exitCode: code, stderrTail: buildTail(lines) });
}

/**
 * Extracts the deduplicated cause lines of one run's output, in order — the input both the
 * taxonomy match and the tail are built from.
 *
 * @param lines - Every non-empty line of the scrubbed output, in order.
 * @returns The cause lines, without duplicates.
 * @example
 * ```ts
 * signalLines(["Building app", "error: Cannot find module 'x'"]);
 * ```
 */
function signalLines(lines: readonly string[]): readonly string[] {
  const causes = lines.filter(line => !IGNORED_LINE_PATTERN.test(line) && isSignalLine(line));
  return [...new Set(causes)];
}

/**
 * Builds the tail carried on a classified error: the extracted cause lines first, then a
 * separator, then the raw trailing lines. A plain "last N lines" tail is useless for
 * xcodebuild — those lines are a simulator destination list, while the cause
 * (`Cannot find module …`, `Command PhaseScriptExecution failed`) is hundreds of lines up.
 * The LAST cause lines are kept, not the first: a long build restates its early warnings
 * while the failure that stopped it is at the end.
 *
 * @param lines - Every non-empty line of the scrubbed output, in order.
 * @returns The tail, joined with `\n`.
 * @example
 * ```ts
 * buildTail(["error: Cannot find module 'x'", "** BUILD FAILED **"]);
 * ```
 */
function buildTail(lines: readonly string[]): string {
  const signal = signalLines(lines).slice(-SIGNAL_LINES);
  const trailing = lines.slice(-STDERR_TAIL_LINES);
  if (signal.length === 0) return trailing.join("\n");
  return [...signal, TAIL_SEPARATOR, ...trailing].join("\n");
}

/**
 * Tests whether one line names a cause worth lifting to the top of the tail.
 *
 * @param line - A single line of scrubbed output.
 * @returns Whether the line is a cause rather than configuration noise.
 * @example
 * ```ts
 * isSignalLine("error: Cannot find module '/repo/tauri.js'"); // true
 * ```
 */
function isSignalLine(line: string): boolean {
  if (line.trimStart().startsWith(EXPORT_LINE_PREFIX)) return false;
  if (SIGNAL_NOISE_PATTERN.test(line)) return false;
  return SIGNAL_LINE_PATTERN.test(line);
}
