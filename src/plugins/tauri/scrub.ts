/**
 * @file tauri plugin — entropy-gated secret scrubbing for subprocess output.
 *
 * Every stdout/stderr line the plugin touches (build ticks, dev output, error
 * tails) is routed through {@link scrub} before it reaches a log, a callback,
 * or a thrown {@link TauriError} — never the raw process output.
 */

/** Replacement text for a masked secret. */
const MASK = "[native:scrubbed]";

/** Tokens shorter than this are never entropy-evaluated (avoids masking normal words/paths). */
const MIN_ENTROPY_TOKEN_LENGTH = 20;

/** Shannon-entropy threshold (bits/char) above which a long token is masked. */
const ENTROPY_THRESHOLD_BITS_PER_CHAR = 4;

/**
 * Tokens carrying a path separator or a Rust path qualifier are locations, not
 * secrets: cargo registry paths, temp dirs, artifact paths, URLs and panic
 * backtraces all clear the entropy bar, and masking them destroys the only
 * actionable part of a build failure. Known secret env-var assignments are
 * masked by name BEFORE this exemption applies, so a secret whose value is a
 * path (`APPLE_API_KEY_PATH`) is still masked.
 */
const LOCATION_TOKEN_PATTERN = /[/\\]|::/;

/**
 * Env-var name prefixes that are ALWAYS masked when found as `NAME=value` /
 * `NAME: value`, regardless of the value's entropy (short passwords included).
 */
const KNOWN_SECRET_ENV_PREFIXES = [
  "APPLE_PASSWORD",
  "APPLE_CERTIFICATE",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "TAURI_SIGNING_",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_PASSWORD"
] as const;

/**
 * Scrubs a line (or block) of subprocess output: known secret env-var
 * assignments are always masked, then any remaining high-entropy token is masked.
 *
 * @param text - Raw subprocess output.
 * @returns The scrubbed text, safe to log/display/embed in an error message.
 * @example
 * ```ts
 * scrub("APPLE_PASSWORD=hunter2"); // "APPLE_PASSWORD=[native:scrubbed]"
 * ```
 */
export function scrub(text: string): string {
  return maskHighEntropyTokens(maskKnownSecretAssignments(text));
}

/**
 * Masks known secret env-var assignments (`NAME=value` / `NAME: value`),
 * regardless of the value's entropy — short passwords included.
 *
 * @param text - Raw subprocess output.
 * @returns Text with every known secret assignment masked.
 * @example
 * ```ts
 * maskKnownSecretAssignments("APPLE_PASSWORD=hunter2");
 * ```
 */
function maskKnownSecretAssignments(text: string): string {
  let result = text;
  for (const prefix of KNOWN_SECRET_ENV_PREFIXES) {
    const pattern = new RegExp(String.raw`\b(${prefix}\w*)(\s*[=:]\s*)(\S+)`, "g");
    result = result.replaceAll(
      pattern,
      (_match, key: string, separator: string) => `${key}${separator}${MASK}`
    );
  }
  return result;
}

/**
 * Masks any remaining whitespace-delimited token whose Shannon entropy
 * exceeds {@link ENTROPY_THRESHOLD_BITS_PER_CHAR}.
 *
 * @param text - Text already passed through {@link maskKnownSecretAssignments}.
 * @returns Text with every high-entropy token masked.
 * @example
 * ```ts
 * maskHighEntropyTokens("token: Tr0ub4dor&3Zx9Qm7Lp2Vy8Wn5Rk1Bc6Ds4Fg");
 * ```
 */
function maskHighEntropyTokens(text: string): string {
  return text.replaceAll(/\S+/g, token => (isHighEntropy(token) ? MASK : token));
}

/**
 * Tests whether a single token is long AND high-entropy enough to mask.
 *
 * @param token - A single whitespace-delimited token.
 * @returns Whether the token should be masked.
 * @example
 * ```ts
 * isHighEntropy("Tr0ub4dor&3Zx9Qm7Lp2Vy8Wn5Rk1Bc6Ds4Fg"); // true
 * ```
 */
function isHighEntropy(token: string): boolean {
  // Already-masked tokens (from the known-name pass) are never re-scanned — the mask
  // marker is glued to the key/separator with no whitespace, which would otherwise
  // read back as one long, high-entropy-looking token.
  if (token.includes(MASK)) return false;
  if (token.length < MIN_ENTROPY_TOKEN_LENGTH) return false;
  if (LOCATION_TOKEN_PATTERN.test(token)) return false;
  return shannonEntropyBitsPerChar(token) >= ENTROPY_THRESHOLD_BITS_PER_CHAR;
}

/**
 * Computes Shannon entropy (bits per character) of `input`.
 *
 * @param input - The string to measure.
 * @returns Bits of entropy per character.
 * @example
 * ```ts
 * shannonEntropyBitsPerChar("aaaaaaaa"); // 0
 * ```
 */
function shannonEntropyBitsPerChar(input: string): number {
  const counts = new Map<string, number>();
  for (const character of input) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / input.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}
