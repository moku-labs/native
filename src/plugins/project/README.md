# project

> Complex plugin — capability registry + `.moku/tauri` generators + write-if-changed writer + mobile init-once-then-patch + clean.

Owns everything about the generated Tauri project as *files*: the capability registry
(name → packaging metadata), all generators for `.moku/tauri/`, the write-if-changed
content-hash writer, the mobile completeness gate, the mobile patch pass, the placeholder
icon, and `clean`. It never spawns subprocesses — running `tauri` verbs is the `tauri`
plugin's job; `build` orchestrates the two.

Mobile permission codegen in v1 is conf-only (D-012): store, notification,
clipboard-manager, and deep-link (custom-scheme-only, D-011) ship zero XML-patching
code, and tray is desktop-only (filtered from every mobile target-set).

## Files

| File | Owns |
|---|---|
| `index.ts` | wiring only — the `api` factory plus the `onInit` config validation |
| `types.ts` | shared types and the public `Api` surface |
| `api.ts` | API factory: capability resolution + the generate/patch/clean/icon delegations |
| `validate.ts` | composition-time global-config validation, called from `onInit` |
| `layout.ts` | **the one owner of the output layout** — the desktop bundle-FORMAT table, the mobile `gen/<platform>` name and `genDirectoryPath(projectDir, target)`, exposed as `getBundleLayout({ target })` |
| `registry.ts` | the capability registry rows, the name guard, and `resolve()` |
| `writer.ts` | write-if-changed (content hash) + the write-path guard |
| `icon.ts` | the embedded 1024x1024 placeholder PNG |
| `clean.ts` | target-scoped destructive cleanup behind the clean guards |
| `paths.ts` | **the one owner of path normalization/containment** — realpath resolution, case rules, the project-anchor walk, and the "is this derived state?" / "may we deliver here?" predicates shared by `clean.ts`, `validate.ts` and (via the API) `build`'s collect guard |
| `generators/*.ts` | one generated artifact each (see the table below) |
| `mobile/completeness.ts` | the `gen/<platform>` required-file set and the completeness gate |
| `mobile/signing.ts` | the Android release-signing block in `app/build.gradle.kts` |
| `mobile/runner.ts` | the Xcode / Android-Studio runner-command rewrite |
| `mobile/patch.ts` | orchestration only — which patches a platform needs, and in which order |

## Generated artifacts

| Path (under `projectDir`) | Generator | What it carries |
|---|---|---|
| `src-tauri/tauri.conf.json` | `generators/tauri-conf.ts` | identity, web build/dev wiring, bundle metadata, Apple signing, a `plugins.<name>` block per **configured** capability |
| `src-tauri/Cargo.toml` | `generators/cargo.ts` | package manifest, `tauri` cargo features, one pinned crate per plugin-backed capability |
| `src-tauri/build.rs` | `generators/build-script.ts` | `tauri_build::build()` — without it capabilities are never compiled in and `tauri build` fails |
| `src-tauri/src/lib.rs`, `src/main.rs` | `generators/rust.ts` | mobile entry point + one `.plugin(...)` line per capability |
| `src-tauri/capabilities/default.json` | `generators/capabilities.ts` | `core:default` + every capability permission, scoped to Tauri's platform id (`macOS`, `iOS`, `windows`, `linux`, `android`) |
| `src-tauri/Entitlements.plist` | `generators/entitlements.ts` | App Store sandbox, only for `signing.apple.appStore` macOS builds with no consumer plist |
| `src-tauri/Info.ios.plist` | `generators/sidecar.ts` | future-mechanism seam — no v1 row emits it |
| `placeholder-icon.png` | `icon.ts` | embedded 1024x1024 PNG, written only when `app.icon` is unset |

Path fields (`build.frontendDist`, `bundle.macOS.entitlements`) are rebased onto
`src-tauri` in POSIX form, because that is where Tauri resolves them from.
`beforeDevCommand`/`beforeBuildCommand` use the object form with an explicit `cwd`, so a
monorepo consumer's web build runs in its own package.

## API

```ts
app.project.generate({ target: "macos" });
// => { written: string[], unchanged: string[], skipped: string[] }

app.project.getCompleteness({ target: "android" });
// => { status: "not-applicable" | "not-initialized" | "incomplete" | "complete", missing?: string[] }

app.project.getBundleLayout({ target: "macos" });
// => { root: "src-tauri/target/release", formats: [{ directory, pattern }], genDirectory?: string }

await app.project.patchMobile({ target: "ios", runner: app.tauri.getRunner() });
// => { patched: string[], unchanged: string[] }

await app.project.ensureIconSource();
// => absolute path to the 1024x1024 source PNG for `tauri icon`

await app.project.clean({ target: "android" }); // omit target to clean the whole projectDir
// => { removed: string[] }

app.project.resolve("deep-link", { mode: "scheme", scheme: "myapp" });
// => ResolvedCapability (registry row + conf/sidecarPlist/manifest)

app.project.isKnownCapability("store"); // => true
app.project.getRegistryRows(); // => copies of the 5 registry rows (consumed by doctor)
app.project.getRequiredFiles({ target: "android" }); // => required gen/android file set (consumed by doctor)
```

- `generate({ target })` — writes/refreshes every pure artifact for a target into
  `projectDir` via write-if-changed. Desktop targets get the whole tree; mobile targets
  get the shared tree + conf (the `gen/` tree itself is created by `tauri android/ios
  init`, never by this plugin).
- `getCompleteness({ target })` — mobile `gen/<platform>` required-file-set gate. Desktop
  targets are `"not-applicable"`.
- `getBundleLayout({ target })` — where that target's build output lands: the output root,
  the desktop bundle-format directories with their artifact globs, and the mobile
  `gen/<platform>` directory. `build`'s collect phase globs against this instead of keeping
  its own copy of the table, so the layout has exactly one owner (`layout.ts`).
- `patchMobile({ target, runner? })` — idempotent post-init patch pass, see below.
- `ensureIconSource()` — returns `path.resolve(app.icon)` when configured, throwing a
  `[native]` error when that file is missing. When unset it writes the embedded
  placeholder PNG to `<projectDir>/placeholder-icon.png` and returns that path, so a
  brand-new app packages without drawing an icon first.
- `clean({ target? })` — deletes derived state. Mobile `target` → `gen/<platform>` only;
  desktop `target` → that target's bundle output; omitted → the whole `projectDir`.
- `resolveDerivedPath(path)` — the one comparable form every containment guard in this
  framework compares in: real path (symlinks followed), NFC, case-folded where the
  filesystem is. `build`'s collect guard borrows it rather than keeping a second, lexical
  copy — a lexical guard is walked around by a single symlink. For comparison only, never
  for display or a filesystem call.
- `resolve(name, config?)` — typed registry lookup; throws when `name` isn't in the
  registry, or when resolving `"deep-link"` without a non-empty `scheme`.
- `isKnownCapability(name)` — runtime narrowing guard for capability names arriving
  from `config.system` as plain strings.

## The mobile patch pass

`tauri ios init` / `tauri android init` write a build phase that shells out to whichever
runner Tauri **detected from the environment** — `node tauri` from a plain shell,
`bun tauri` under `bun run` (`npm_execpath` is set), and also `npm run tauri --`,
`yarn tauri`, `pnpm tauri`, `cargo tauri`. None of those resolve inside Xcode or Android
Studio, so a build of a freshly-initialised tree fails on its first build phase. Passing
`runner` (from the `tauri` plugin's `runner()`) rewrites it to an absolute
`<node> <tauri.js> <verb>` invocation, with each path quoted so paths containing spaces
survive:

| Platform | Files rewritten | Everything else on the line | Quote form |
|---|---|---|---|
| ios | `gen/apple/project.yml` | `script: ` (with any indent / `- `) | `"…"` (YAML scalar) |
| ios | `gen/apple/*.xcodeproj/project.pbxproj` | `shellScript = "` | `\"…\"` (inside a pbxproj string) |
| android | `gen/android/buildSrc/**/*.{kt,kts,gradle}`, the two top-level `build.gradle.kts` | the string literal's opening `"` | `\"…\"` (inside a source string) |

The match is **runner-agnostic but narrow**: on every line carrying ` ios xcode-script` /
` android android-studio-script`, only the runner-shaped token run directly before the verb is
replaced — `<binary> tauri` (optionally path-qualified), `npm run tauri --`, a bare `tauri`, or
an already-absolute quoted pair. Everything else survives byte for byte, including a shell
preamble such as `set -e` / `cd "$SRCROOT" &&` and the verb's own arguments. Each path is
escaped for the double-quoted shell word it lands in (`\`, `"`, `$`, backtick), and a path
containing a line break is refused with a `[native]` error. Omit `runner` and the rewrite is
skipped. The pass is idempotent: a second run rewrites the absolute pair onto itself and reports
every file unchanged — but an absolute pair whose Node path CHANGED (an fnm/nvm switch) is
re-patched, not left stale.

A file that invokes the verb behind a runner shape the match does **not** recognize is an
error, never an "unchanged" file — reporting success there ships a tree that fails on its
first Xcode/Android-Studio build phase, with nothing in the log pointing back here:

```
[native] Could not find a Tauri runner command before "ios xcode-script" in <file>.
  Set pluginConfigs.tauri.nodePath, or report the runner line Tauri generated.
```

A file that never mentions the verb is simply unchanged.

## Signing

Config holds identifiers and env-var *names* only. Secrets stay in the environment, where
Tauri and Gradle read them directly.

**Android.** `patchMobile({ target: "android" })` maintains a sentinel-delimited
`// MOKU-SIGNING-START … // MOKU-SIGNING-END` block in `gen/android/app/build.gradle.kts`:

```kotlin
signingConfigs { maybeCreate("release").apply { storeFile = file(…); keyAlias = …
  storePassword = System.getenv("<keystorePasswordEnv>")
  keyPassword = System.getenv("<keyPasswordEnv ?? keystorePasswordEnv>") } }
buildTypes { getByName("release") { signingConfig = signingConfigs.getByName("release") } }
```

Every interpolated value (keystore path, key alias, env-var names) is escaped for a
double-quoted Kotlin literal first — `\`, `"`, `$` and newlines — so a path with a quote
in it cannot close the literal, and a `$` cannot interpolate a Gradle expression.

No `keystore.properties` is written any more. Dropping `signing.android.keystorePath`
removes the block *and* a legacy `keystore.properties` left by an older build (a single
named file inside `gen/android`, never a recursive remove).

**Apple.** `signing.apple` maps into `tauri.conf.json`:

| Config | tauri.conf.json |
|---|---|
| `teamId` | `bundle.iOS.developmentTeam` |
| `signingIdentity` | `bundle.macOS.signingIdentity` (`"-"` = ad-hoc) |
| `providerShortName` | `bundle.macOS.providerShortName` |
| `entitlements` | `bundle.macOS.entitlements`, rebased onto `src-tauri` |
| `appStore: true` | generates `src-tauri/Entitlements.plist` (sandbox + network client) for macOS when `entitlements` is unset |
| `macosMinimumSystemVersion` / `iosMinimumSystemVersion` | `bundle.{macOS,iOS}.minimumSystemVersion` |
| `exportMethod` | read by the `tauri` plugin, not by this one |

`app.category` and `app.buildNumber` map to `bundle.category` and
`bundle.{iOS,macOS}.bundleVersion`. Every one of these keys is ABSENT from the JSON when
unset — `bundle.iOS` and `bundle.android` stay as empty objects, `bundle.macOS` is omitted
entirely.

## Safety: the path rules

`projectDir` is gitignored build output, so `clean()` is destructive by design. One helper
(`paths.ts`) decides what counts as derived state, and the destructive guard, the
composition-time config check and build's collect guard (through
`project.resolveDerivedPath`) all ask it — so what `createApp` accepts, what `clean()` is
willing to delete and what `collect` is willing to overwrite can never drift apart.

**The rule is positive containment, not a blacklist.** A directory is derived state only if
it resolves strictly INSIDE the project anchor (or inside a usable OS temp root, where test
and smoke workspaces are `mkdtemp`'d), and is not — and does not contain — the anchor, the
cwd or the home directory. `~/Documents` is refused for the same reason `/` is: it was
never derived state, it just is not on a list of famous paths.

The **anchor** is the nearest ancestor of the cwd (the cwd itself included) carrying a
`.git` entry or a `package.json` with a `workspaces` field, stopping before `$HOME` and
before a filesystem root; with no marker anywhere the cwd stands. The cwd alone is the wrong
boundary: a monorepo script runs from `packages/app` while its absolute `projectDir` lives
at the repository root, and measuring against the cwd rejects a perfectly ordinary layout.
The walk is a pure function over an injectable filesystem probe.

| Rule | Why |
|---|---|
| resolved with `realpath` when the path exists | a symlink pointing out of the project is judged where it lands, not where it reads |
| compared NFC-normalized, case-insensitively on darwin/win32 | `/Repo/App` and `/repo/app` are the same directory there |
| must be strictly inside the anchor or the temp root | an absolute path elsewhere on the disk is never this app's build output |
| must not be, or contain, the anchor, cwd or home | a `projectDir` that swallows the checkout deletes the checkout |
| must not be a filesystem root | — |
| a temp root that is a filesystem root, or that is/contains `$HOME`, grants nothing | `os.tmpdir()` follows `TMPDIR`, so the second allowed root is consumer-controlled; `TMPDIR=/` would otherwise bless the whole disk |

`outDir` gets a **looser** rule (`isDeliveryPath`): it is written into and replaced file by
file, never recursively cleaned, so a CI cache mount or a shared artifacts volume outside
the checkout is legitimate. Only a filesystem root, the home directory itself, and any
ancestor of the cwd or of `$HOME` are refused.

Before any path is computed, `assertCleanableRoot(root, cwd, home, platform)` applies the
`projectDir` rule:

```
[native] Refusing to clean projectDir "<root>".
  Set config.projectDir to a dedicated subdirectory such as ".moku/tauri".
```

It is a pure predicate and it is tested as one — an unsafe path is never handed to
`clean()`. Every surviving candidate path is then validated against `projectDir` by
`assertWithinRoot` before deletion.

The writer has the mirror-image guard. `assertWritablePath` refuses:

- any path **outside `projectDir`** — an empty, `..`-leading or absolute relative form:
  `[native] Refusing to write outside projectDir: <path>.`
- any path through `target/`, `.gradle/`, `DerivedData` or `Pods`, scanning **only the path
  below `projectDir`** — a repository checked out under a directory called `target` is a
  normal checkout, not a violation.

## Configuration

This plugin has no per-plugin config — it reads global config only (`ctx.global`):
`app`, `web`, `system`, `capabilities`, `targets`, `projectDir`, `outDir`, `signing`
(all declared in the framework's `src/config.ts`).

`onInit` runs `validate.ts` over the global config at composition time and throws
`[native]`-prefixed errors for:

| Config | Rejected when |
|---|---|
| `app.name` | missing or empty |
| `app.identifier` | not reverse-DNS |
| `app.version` | not `MAJOR.MINOR.PATCH[-+suffix]` — it lands raw in a Cargo TOML string |
| `app.buildNumber` | anything but word characters and dots — it lands raw in plist/JSON |
| `web.build` / `web.devCommand` / `web.devUrl` / `web.dist` | missing |
| `signing.android.keystorePasswordEnv` / `keyPasswordEnv` | not a POSIX env-var NAME — it lands raw inside a Kotlin `System.getenv("…")` |
| `projectDir` | resolving outside the project (the same rule as the clean guard) |
| `outDir` | a filesystem root, `$HOME`, or an ancestor of the cwd or `$HOME` |
| `config.system` entries | not in the capability registry |
| `capabilities["deep-link"].scheme` | missing, or not a valid URL scheme, while `deep-link` is composed |

The value rules exist because each of those strings is interpolated **verbatim** into a
generated file: a quote in the wrong place rewrites the file around it. Failing at
`createApp` is also what makes the `projectDir` rule useful — the misconfiguration is
reported before anything is generated, not at clean time.

### Capability registry (5 rows)

| Capability | Platforms | Backed by | Confidence |
|---|---|---|---|
| `store` | all 5 | crate + npm package + Rust init | high |
| `notification` | all 5 | crate + npm package + Rust init | high |
| `clipboard-manager` | all 5 | crate + npm package + Rust init | high |
| `tray` | desktop only (macos/windows/linux) | **cargo feature `tray-icon`** — no crate, no npm package, no Rust init | low |
| `deep-link` | all 5 (custom-scheme-only, D-011) | crate + npm package + Rust init | high |

`tray` is the reason every plugin-shaped field on `RegistryRow` is optional while
`cargoFeatures` is required: it is a core Tauri feature flag, not a plugin. Consumers of
`getRegistryRows()` (doctor) null-check `npmPackage`/`crate` before use. `getRegistryRows()`
returns fresh copies, so a caller can never mutate the registry.

`deep-link` resolves to the plugin's real two-sided conf shape:

```json
{ "desktop": { "schemes": ["myapp"] },
  "mobile": [{ "scheme": ["myapp"], "appLink": false }] }
```

It is also the only row that gets a `plugins.<name>` key at all. `store`, `notification`
and `clipboard-manager` take **no** config: their Tauri plugin deserializes the config
slot as `unit`, so an empty `{}` map under their key aborts the app on the first frame
with `PluginInitialization("clipboard-manager", "… invalid type: map, expected unit")`.
A capability whose resolved conf has zero keys therefore contributes no key — only the
empty `"plugins": {}` object survives, which Tauri accepts.
