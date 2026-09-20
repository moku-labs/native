/**
 * @file project plugin — composition-time validation of the global config. Runs in the
 * plugin's `onInit`, so a misconfigured app fails at `createApp` with a `[native]` fix-it
 * instead of deep inside `tauri build`.
 */
import type { Config } from "../../config";
import { isDeliveryPath, isDerivedPath } from "./paths";
import { assertKnownCapabilities } from "./registry";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/i;

/** `MAJOR.MINOR.PATCH` with an optional pre-release/build suffix — lands raw in Cargo TOML. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;

/** Bundle version: word characters and dots only — lands raw in Info.plist/tauri.conf.json. */
const BUILD_NUMBER_PATTERN = /^[\w.]+$/;

/** RFC 3986 scheme shape — lands raw in Info.plist and AndroidManifest.xml. */
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*$/i;

/** POSIX environment variable name — lands raw inside a Kotlin `System.getenv("…")` call. */
const ENV_VAR_NAME_PATTERN = /^[a-z_][a-z\d_]*$/i;

/**
 * Validates one free-text config value that is interpolated verbatim into a generated
 * file. Every generated format (TOML, Kotlin, plist, XML) has its own escape rules, so a
 * value that cannot be expressed safely is rejected at composition time instead of being
 * quoted into one of them.
 *
 * @param field - The dotted config path, used verbatim in the error.
 * @param value - The configured value, or undefined when the field is unset.
 * @param pattern - The shape the value must match.
 * @param problem - How the error names the violation (`is not a valid …`).
 * @param fix - The second error line telling the consumer what to set instead.
 * @throws {Error} When `value` is set and does not match `pattern`.
 * @example
 * ```ts
 * assertShape("app.version", global.app.version, VERSION_PATTERN, "semantic version", 'Use "1.0.0".');
 * ```
 */
function assertShape(
  field: string,
  value: string | undefined,
  pattern: RegExp,
  problem: string,
  fix: string
): void {
  if (value === undefined || pattern.test(value)) return;

  throw new Error(`[native] ${field} "${value}" is not a valid ${problem}.\n  ${fix}`);
}

/**
 * Validates that `projectDir` is derived state this app may own — it must resolve strictly
 * inside the project (the nearest repository/workspace root at or above the cwd) or inside
 * the OS temp root, where test workspaces live. This is the composition-time twin of the
 * clean guard: a `projectDir` that `clean()` would refuse to delete now fails at
 * `createApp` instead.
 *
 * @param value - The configured project directory.
 * @throws {Error} When the directory is not derived state this app may delete.
 * @example
 * ```ts
 * assertDerivedDirectory(global.projectDir);
 * ```
 */
function assertDerivedDirectory(value: string): void {
  if (isDerivedPath(value)) return;

  throw new Error(
    `[native] config.projectDir "${value}" resolves outside the project.\n  Set config.projectDir to a path inside the project, such as ".moku/tauri".`
  );
}

/**
 * Validates that `outDir` may receive delivered artifacts. Deliberately looser than
 * {@link assertDerivedDirectory}: `outDir` is written into and replaced file by file, never
 * recursively cleaned, so a CI cache mount or a shared artifacts volume outside the
 * checkout is legitimate. Only a filesystem root, the home directory, and an ancestor of
 * the working or home directory are refused.
 *
 * @param value - The configured delivery directory.
 * @throws {Error} When the directory is one this app must not write installers into.
 * @example
 * ```ts
 * assertDeliveryDirectory(global.outDir);
 * ```
 */
function assertDeliveryDirectory(value: string): void {
  if (isDeliveryPath(value)) return;

  throw new Error(
    `[native] config.outDir "${value}" is a directory this app must not deliver into.\n  Set config.outDir to a dedicated delivery directory such as "dist-native".`
  );
}

/**
 * Validates the global config at composition time — throws `[native]`-formatted errors
 * for missing app identity, missing web wiring, values that would break out of the
 * generated file they are written into, a `projectDir` outside the project, an `outDir`
 * this app must not deliver into, unknown `config.system` names, or a `deep-link`
 * composition missing its scheme.
 *
 * @param global - Frozen global framework config.
 * @throws {Error} When identity, web wiring, interpolated values, derived directories,
 *   system names, or deep-link config are invalid.
 * @example
 * ```ts
 * validateProjectConfig(ctx.global);
 * ```
 */
export function validateProjectConfig(global: Readonly<Config>): void {
  // Stanza 1 — identity and web wiring. Every field below lands verbatim in
  // tauri.conf.json, where a missing value fails deep inside `tauri build` instead.
  if (!global.app.name) {
    throw new Error(
      "[native] app.name is required.\n  Set config.app.name to your app's display name."
    );
  }
  if (!IDENTIFIER_PATTERN.test(global.app.identifier)) {
    throw new Error(
      `[native] app.identifier "${global.app.identifier}" is not a valid reverse-DNS identifier.\n  Use a reverse-DNS identifier such as "com.example.myapp".`
    );
  }
  if (!global.web.build) {
    throw new Error(
      "[native] web.build is required.\n  Set config.web.build to the command that builds your web assets."
    );
  }
  if (!global.web.devCommand) {
    throw new Error(
      "[native] web.devCommand is required.\n  Set config.web.devCommand to the command that starts your dev server."
    );
  }
  if (!global.web.devUrl) {
    throw new Error(
      "[native] web.devUrl is required.\n  Set config.web.devUrl to your dev server's URL."
    );
  }
  if (!global.web.dist) {
    throw new Error(
      "[native] web.dist is required.\n  Set config.web.dist to your web build's output directory."
    );
  }

  // Stanza 2 — values that are interpolated VERBATIM into a generated file. A version goes
  // into a Cargo TOML string, a build number into plist/JSON, an env-var name into a Kotlin
  // string literal: each one is a quote away from rewriting the file around it.
  assertShape(
    "app.version",
    global.app.version,
    VERSION_PATTERN,
    "semantic version",
    'Use a MAJOR.MINOR.PATCH version such as "1.0.0".'
  );
  assertShape(
    "app.buildNumber",
    global.app.buildNumber,
    BUILD_NUMBER_PATTERN,
    "build number",
    'Use digits, letters, dots or underscores, such as "42" or "1.0.3".'
  );
  assertShape(
    "signing.android.keystorePasswordEnv",
    global.signing.android?.keystorePasswordEnv,
    ENV_VAR_NAME_PATTERN,
    "environment variable name",
    'Reference the password by variable NAME, such as "ANDROID_KEYSTORE_PASSWORD" — never the password itself.'
  );
  assertShape(
    "signing.android.keyPasswordEnv",
    global.signing.android?.keyPasswordEnv,
    ENV_VAR_NAME_PATTERN,
    "environment variable name",
    'Reference the password by variable NAME, such as "ANDROID_KEY_PASSWORD" — never the password itself.'
  );

  // Stanza 3 — the directories this framework writes into and deletes from. projectDir is
  // checked with the same containment rule the destructive clean guard uses, so a
  // projectDir clean() would refuse fails here, at createApp, instead of at clean time.
  // outDir is only ever written into, and gets the looser delivery rule.
  assertDerivedDirectory(global.projectDir);
  assertDeliveryDirectory(global.outDir);

  // Stanza 4 — the composed capability set. Names are validated against the registry, and
  // deep-link is the one row that cannot be packaged from its defaults alone.
  assertKnownCapabilities(global.system);

  const usesDeepLink = global.system.some(entry => entry.name === "deep-link");
  if (!usesDeepLink) return;

  const scheme = global.capabilities["deep-link"]?.scheme;
  if (!scheme) {
    throw new Error(
      '[native] deep-link is composed in config.system but capabilities["deep-link"].scheme is missing.\n  Set capabilities["deep-link"] = { mode: "scheme", scheme: "yourscheme" }.'
    );
  }
  assertShape(
    'capabilities["deep-link"].scheme',
    scheme,
    URL_SCHEME_PATTERN,
    "URL scheme",
    'Use a scheme that starts with a letter and carries no spaces or separators, such as "myapp".'
  );
}
