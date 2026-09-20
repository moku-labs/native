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
| `layout.ts` | **the one owner of the output layout** — the desktop bundle-FORMAT table and the mobile `gen/<platform>` name, exposed as `getBundleLayout({ target })` |
| `registry.ts` | the capability registry rows, the name guard, and `resolve()` |
| `writer.ts` | write-if-changed (content hash) + the write-path guard |
| `icon.ts` | the embedded 1024x1024 placeholder PNG |
| `clean.ts` | target-scoped destructive cleanup behind the clean guards |
| `generators/*.ts` | one generated artifact each (see the table below) |
| `mobile/completeness.ts` | the `gen/<platform>` required-file set and the completeness gate |
| `mobile/signing.ts` | the Android release-signing block in `app/build.gradle.kts` |
| `mobile/runner.ts` | the Xcode / Android-Studio runner-command rewrite |
| `mobile/patch.ts` | orchestration only — which patches a platform needs, and in which order |

## Generated artifacts

| Path (under `projectDir`) | Generator | What it carries |
|---|---|---|
| `src-tauri/tauri.conf.json` | `generators/tauri-conf.ts` | identity, web build/dev wiring, bundle metadata, Apple signing, `plugins.<name>` blocks |
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

| Platform | Files rewritten | Line prefix kept | Quote form |
|---|---|---|---|
| ios | `gen/apple/project.yml` | `script: ` (with any indent / `- `) | `"…"` (YAML scalar) |
| ios | `gen/apple/*.xcodeproj/project.pbxproj` | `shellScript = "` | `\"…\"` (inside a pbxproj string) |
| android | `gen/android/buildSrc/**/*.{kt,kts,gradle}`, the two top-level `build.gradle.kts` | the string literal's opening `"` | `\"…\"` (inside a source string) |

The match is **runner-agnostic**: on every line carrying ` ios xcode-script` /
` android android-studio-script`, whatever sits between the line's prefix and the verb is
replaced — no literal is hard-coded. Omit `runner` and the rewrite is skipped. The pass is
idempotent: a second run rewrites the absolute pair onto itself and reports every file
unchanged.

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

## Safety: the clean guard

`projectDir` is gitignored build output, so `clean()` is destructive by design. Before any
path is computed, `assertCleanableRoot(root, cwd, home)` refuses a `projectDir` that is the
current working directory, the home directory, a filesystem root, or an ancestor of the
cwd, with:

```
[native] Refusing to clean projectDir "<root>".
  Set config.projectDir to a dedicated subdirectory such as ".moku/tauri".
```

It is a pure predicate and it is tested as one — an unsafe path is never handed to
`clean()`. Every surviving candidate path is then validated against `projectDir` by
`assertWithinRoot` before deletion.

The writer has the mirror-image guard: `assertWritablePath` refuses to write into
`target/`, `.gradle/`, `DerivedData` or `Pods`, scanning **only the path below
`projectDir`** — a repository checked out under a directory called `target` is a normal
checkout, not a violation.

## Configuration

This plugin has no per-plugin config — it reads global config only (`ctx.global`):
`app`, `web`, `system`, `capabilities`, `targets`, `projectDir`, `outDir`, `signing`
(all declared in the framework's `src/config.ts`).

`onInit` runs `validate.ts` over the global config at composition time and throws
`[native]`-prefixed errors for: a missing/empty `app.name`, a non-reverse-DNS `app.identifier`, missing
`web.build`/`web.devCommand`/`web.devUrl`/`web.dist`, any `config.system` entry the
registry doesn't recognize, and a `"deep-link"` entry in `config.system` without a
matching non-empty `capabilities["deep-link"].scheme`.

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
