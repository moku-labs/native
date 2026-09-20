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
 * backtraces all clear the entropy bar as a whole, and masking them destroys the
 * only actionable part of a build failure. A location is not exempt, though — it
 * is scanned SEGMENT by segment, so a secret pasted into a path is still masked
 * while the readable part of the path survives. Known secret env-var assignments
 * are masked by name BEFORE any of this, so a secret whose value is a path
 * (`APPLE_API_KEY_PATH`) is still masked whole.
 */
const LOCATION_TOKEN_PATTERN = /[/\\]|::/;

/** One path segment of a location-shaped token (the run between two separators). */
const PATH_SEGMENT_PATTERN = /[^/\\]+/g;

/**
 * The cargo registry's index segment — `index.crates.io-<hash>` and its git-era
 * `github.com-<hash>` predecessor. It is a well-known location that sits right at the
 * entropy bar, and it is in every single compile line.
 */
const CARGO_REGISTRY_SEGMENT_PATTERN =
  /^[^\w-]*(?:index\.crates\.io|github\.com)-[\da-f]+[^\w-]*$/i;

/**
 * A token the hex rule has already judged: one hexadecimal run with nothing but
 * punctuation around it. The entropy pass must not second-guess that verdict — a `#`
 * glued to a git sha is enough to push the token over the bar, which would mask exactly
 * the identifiers {@link maskLongHexRuns} deliberately kept.
 */
const HEX_TOKEN_PATTERN = /^[^\w-]*[\da-f]+[^\w-]*$/i;

/**
 * Credentials embedded in a URL (`scheme://user:token@host`) — always masked, whatever
 * their entropy, because a URL is location-shaped and would otherwise be exempt. Only the
 * userinfo is replaced: the scheme and host stay readable. Both runs are bounded — a
 * scrubber walks every line of a 50k-line build log and must not backtrack.
 */
const URL_USERINFO_PATTERN = /([a-z][\w+.-]{0,30}:\/\/)[^\s/@]{1,256}@/gi;

/** A standalone hexadecimal run long enough to be a digest, key or token. */
const LONG_HEX_RUN_PATTERN = /(^|[^\w-])([\da-f]{32,})(?![\w-])/gi;

/**
 * Context that turns a long hex run into an identifier rather than a secret: a git sha
 * announced by `commit `, `rev ` or a leading `#`.
 */
const SHA_CONTEXT_PATTERN = /(?:\bcommit\s|\brev\s|#)$/i;

/** A canonical 8-4-4-4-12 hex UUID — a device/simulator identifier, never a secret. */
const UUID_PATTERN = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi;

/**
 * What may surround a UUID inside one whitespace-delimited token and still leave it an
 * identifier: a short `key:`/`key=` prefix and trailing punctuation. `xcodebuild
 * -showdestinations` prints `id:41E558D0-…-075F9BC510DC,`, and masking it deletes the
 * only way to name the simulator the build failed on.
 */
const UUID_TOKEN_RESIDUE_PATTERN = /^\w{0,12}[:=]?[,;.)\]}"']*$/;

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
 * Scrubs a line (or block) of subprocess output, in four passes: known secret
 * env-var assignments, URL userinfo, long hexadecimal runs, then any remaining
 * high-entropy token (per path segment, for location-shaped tokens).
 *
 * @param text - Raw subprocess output.
 * @returns The scrubbed text, safe to log/display/embed in an error message.
 * @example
 * ```ts
 * scrub("APPLE_PASSWORD=hunter2"); // "APPLE_PASSWORD=[native:scrubbed]"
 * ```
 */
export function scrub(text: string): string {
  return maskHighEntropyTokens(maskLongHexRuns(maskUrlUserInfo(maskKnownSecretAssignments(text))));
}

/**
 * Masks known secret env-var assignments (`NAME=value` / `NAME: value`),
 * regardless of the value's entropy — short passwords included. A quoted value is
 * captured whole, so a password containing spaces does not leak its tail.
 *
 * @param text - Raw subprocess output.
 * @returns Text with every known secret assignment masked.
 * @example
 * ```ts
 * maskKnownSecretAssignments('APPLE_PASSWORD="correct horse"');
 * ```
 */
function maskKnownSecretAssignments(text: string): string {
  let result = text;
  for (const prefix of KNOWN_SECRET_ENV_PREFIXES) {
    const pattern = new RegExp(String.raw`\b(${prefix}\w*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)`, "g");
    result = result.replaceAll(
      pattern,
      (_match, key: string, separator: string) => `${key}${separator}${MASK}`
    );
  }
  return result;
}

/**
 * Masks the credentials in a `scheme://user:token@host` URL. Git remotes and registry
 * URLs carry tokens this way, and a URL is location-shaped, so the entropy pass would
 * otherwise wave the whole thing through.
 *
 * @param text - Text already passed through {@link maskKnownSecretAssignments}.
 * @returns Text with every URL userinfo masked, scheme and host intact.
 * @example
 * ```ts
 * maskUrlUserInfo("https://alex:token@github.com/moku/native.git");
 * ```
 */
function maskUrlUserInfo(text: string): string {
  return text.replaceAll(URL_USERINFO_PATTERN, (_match, scheme: string) => `${scheme}${MASK}@`);
}

/**
 * Masks standalone hexadecimal runs of 32 characters or more — digests, API keys and
 * private-key material. Hex tops out at exactly 4 bits/char, so the entropy pass can
 * never reach it; this rule is what covers it. Git shas announced by their context
 * (`commit <sha>`, `rev <sha>`, `#<sha>`) are identifiers and stay readable, and a
 * canonical UUID never matches because its longest hex run is 12 characters.
 *
 * @param text - Text already passed through {@link maskUrlUserInfo}.
 * @returns Text with every anonymous long hex run masked.
 * @example
 * ```ts
 * maskLongHexRuns("digest 9f2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d");
 * ```
 */
function maskLongHexRuns(text: string): string {
  return text.replaceAll(
    LONG_HEX_RUN_PATTERN,
    (match: string, lead: string, _hex: string, offset: number, whole: string) => {
      const before = whole.slice(0, offset) + lead;
      if (SHA_CONTEXT_PATTERN.test(before)) return match;
      return `${lead}${MASK}`;
    }
  );
}

/**
 * Masks any remaining whitespace-delimited token whose Shannon entropy
 * exceeds {@link ENTROPY_THRESHOLD_BITS_PER_CHAR}.
 *
 * @param text - Text already passed through {@link maskLongHexRuns}.
 * @returns Text with every high-entropy token (or path segment) masked.
 * @example
 * ```ts
 * maskHighEntropyTokens("token: Tr0ub4dor&3Zx9Qm7Lp2Vy8Wn5Rk1Bc6Ds4Fg");
 * ```
 */
function maskHighEntropyTokens(text: string): string {
  return text.replaceAll(/\S+/g, token => maskToken(token));
}

/**
 * Masks one whitespace-delimited token. A location-shaped token keeps its structure and
 * is judged segment by segment; anything else is judged whole.
 *
 * @param token - A single whitespace-delimited token.
 * @returns The token, or the mask, or the token with its secret segments masked.
 * @example
 * ```ts
 * maskToken("/var/tmp/aB3xQ9zP1mK7vR2tY8wL4nC6jF0sH5dG/App.dmg");
 * ```
 */
function maskToken(token: string): string {
  // Already-masked tokens (from the earlier passes) are never re-scanned — the mask
  // marker is glued to the key/separator with no whitespace, which would otherwise
  // read back as one long, high-entropy-looking token.
  if (token.includes(MASK)) return token;

  if (LOCATION_TOKEN_PATTERN.test(token)) {
    return token.replaceAll(PATH_SEGMENT_PATTERN, segment =>
      isHighEntropy(segment) ? MASK : segment
    );
  }
  return isHighEntropy(token) ? MASK : token;
}

/**
 * Tests whether a token (or one path segment of one) is long AND high-entropy
 * enough to mask.
 *
 * @param token - A whitespace-delimited token or one of its path segments.
 * @returns Whether it should be masked.
 * @example
 * ```ts
 * isHighEntropy("Tr0ub4dor&3Zx9Qm7Lp2Vy8Wn5Rk1Bc6Ds4Fg"); // true
 * ```
 */
function isHighEntropy(token: string): boolean {
  if (token.length < MIN_ENTROPY_TOKEN_LENGTH) return false;
  if (CARGO_REGISTRY_SEGMENT_PATTERN.test(token)) return false;
  if (HEX_TOKEN_PATTERN.test(token)) return false;
  if (isUuidToken(token)) return false;
  return shannonEntropyBitsPerChar(token) >= ENTROPY_THRESHOLD_BITS_PER_CHAR;
}

/**
 * Tests whether a token is nothing but canonical UUIDs plus a short key prefix and
 * punctuation. Roughly half of all UUIDs clear the entropy bar, so without this the
 * simulator destination list comes back fully masked.
 *
 * @param token - A single whitespace-delimited token.
 * @returns Whether the token is an identifier rather than a candidate secret.
 * @example
 * ```ts
 * isUuidToken("id:41E558D0-66F5-4CA4-90E5-075F9BC510DC,"); // true
 * ```
 */
function isUuidToken(token: string): boolean {
  const residue = token.replaceAll(UUID_PATTERN, "");
  if (residue.length === token.length) return false;
  return UUID_TOKEN_RESIDUE_PATTERN.test(residue);
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
