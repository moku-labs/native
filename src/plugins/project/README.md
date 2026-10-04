# project

> Complex plugin — capability registry + `.moku/tauri` generators + write-if-changed writer + mobile init-once-then-patch + clean.

Owns everything about the generated Tauri project as *files*: the capability registry
(name → packaging metadata), all generators for `.moku/tauri/`, the write-if-changed
content-hash writer, the mobile completeness gate, the mobile patch pass, the placeholder
icon, and `clean`. It never spawns subprocesses — running `tauri` verbs is the `tauri`
plugin's job; `build` orchestrates the two.

Mobile permission codegen is conf-only (D-012): store, notification, clipboard-manager,
deep-link (custom-scheme-only, D-011), back and haptics need no XML patch (the haptics
plugin merges `VIBRATE` itself), and tray is desktop-only (filtered from every mobile
target-set). The XML this plugin does write is presentation: the orientation lock, as
`Info.ios.plist` keys and an `android:screenOrientation` attribute on the main activity.
The one Kotlin source it styles is presentation too: the Android status bar icons follow
`app.backgroundColor` through the generated `MainActivity.kt`.

## Files

| File | Owns |
|---|---|
| `index.ts` | wiring only — the `api` factory plus the `onInit` config validation |
| `types.ts` | shared types and the public `Api` surface |
| `api.ts` | API factory: capability resolution + the generate/patch/clean/icon delegations |
| `validate.ts` | composition-time global-config validation, called from `onInit` |
| `layout.ts` | **the one owner of the output layout** — the desktop bundle-FORMAT table, the mobile `gen/<platform>` name and `genDirectoryPath(projectDir, target)`, exposed as `getBundleLayout({ target })` |
| `registry.ts` | the capability registry rows, the name guard, and `resolve()` |
| `orientation.ts` | the build-time orientation lock: its `Info.ios.plist` entries and its Android main-activity attribute |
| `xml.ts` | XML text escaping, shared by the plist sidecar and the manifest patch |
| `writer.ts` | write-if-changed (content hash) + the write-path guard |
| `icon.ts` | the embedded 1024x1024 placeholder PNG |
| `clean.ts` | target-scoped destructive cleanup behind the clean guards |
| `paths.ts` | **the one owner of path normalization/containment** — realpath resolution, case rules, the project-anchor walk, and the "is this derived state?" / "may we deliver here?" predicates shared by `clean.ts`, `validate.ts` and (via the API) `build`'s collect guard |
| `generators/*.ts` | one generated artifact each (see the table below) |
| `mobile/completeness.ts` | the `gen/<platform>` required-file set and the completeness gate |
| `mobile/files.ts` | **the one owner of which generated files a patch may touch** — never anything under `gen/*/build` |
| `mobile/signing.ts` | the Android release-signing block in `app/build.gradle.kts` |
| `mobile/manifest.ts` | the main `<activity>` attributes in `app/src/main/AndroidManifest.xml` |
| `mobile/system-bars.ts` | the Android status bar icon style in `app/src/main/java/**/MainActivity.kt`, from `app.backgroundColor` |
| `mobile/runner.ts` | the Xcode / Android-Studio runner-command rewrite |
| `mobile/xcode-settings.ts` | the iOS entitlements-modification setting (`project.pbxproj` + `project.yml`) |
| `mobile/patch.ts` | orchestration only — which patches a platform needs, and in which order |

## Generated artifacts

| Path (under `projectDir`) | Generator | What it carries |
|---|---|---|
| `src-tauri/tauri.conf.json` | `generators/tauri-conf.ts` | identity, web build/dev wiring, the main window (title, `app.backgroundColor`), bundle metadata, Apple signing, a `plugins.<name>` block per **configured** capability |
| `src-tauri/Cargo.toml` | `generators/cargo.ts` | package manifest, `tauri` (floor `2.12`) with its cargo features, one pinned crate per plugin-backed capability, and the iOS-only `objc2` table |
| `src-tauri/build.rs` | `generators/build-script.ts` | `tauri_build::build()` — without it capabilities are never compiled in and `tauri build` fails |
| `src-tauri/src/lib.rs`, `src/main.rs` | `generators/rust.ts` | mobile entry point + one `.plugin(...)` line per capability + the iOS safe-area `.setup` hook |
| `src-tauri/capabilities/default.json` | `generators/capabilities.ts` | `core:default` + every capability permission, scoped to Tauri's platform id (`macOS`, `iOS`, `windows`, `linux`, `android`) |
| `src-tauri/Entitlements.plist` | `generators/entitlements.ts` | App Store sandbox, only for `signing.apple.appStore` macOS builds with no consumer plist |
| `src-tauri/Info.ios.plist` | `generators/sidecar.ts` | iOS only, always written: the orientation lock plus any capability `sidecarPlist`; an empty `<dict>` when nothing is locked |
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
app.project.getRegistryRows(); // => copies of the 7 registry rows (consumed by doctor)
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
- `clearMobileBuildOutput({ target })` — removes the PREVIOUS build output of a mobile
  target so the next compile writes into an empty tree: `gen/apple/build` for iOS, nothing
  for Android (Gradle manages its own `build` tree and reuses it correctly). Missing
  directory → `{ removed: [] }`. `build` calls it at the start of the compile phase; see
  [iOS rebuilds](#ios-rebuilds).
- `resolveDerivedPath(path)` — the one comparable form every containment guard in this
  framework compares in: real path (symlinks followed), NFC, case-folded where the
  filesystem is. `build`'s collect guard borrows it rather than keeping a second, lexical
  copy — a lexical guard is walked around by a single symlink. For comparison only, never
  for display or a filesystem call.
- `resolve(name, config?)` — typed registry lookup; throws when `name` isn't in the
  registry, or when resolving `"deep-link"` without a non-empty `scheme`.
- `isKnownCapability(name)` — runtime narrowing guard for capability names arriving
  from `config.system` as plain strings.

## Mobile presentation

Three config fields shape how the app sits on a phone screen. All three are build time
only.

**Orientation.** `app.orientation` locks the screen. Nothing locks it at runtime.

| `app.orientation` | `Info.ios.plist` | Android main activity |
|---|---|---|
| `"portrait"` | `UISupportedInterfaceOrientations` = Portrait; `~ipad` = Portrait, PortraitUpsideDown; `UIRequiresFullScreen` = true | `android:screenOrientation="portrait"` |
| `"landscape"` | both keys = LandscapeLeft, LandscapeRight; `UIRequiresFullScreen` = true | `android:screenOrientation="sensorLandscape"` |
| `"any"` / unset | no keys: the template's list (every orientation) stays | the attribute is removed |

`UIRequiresFullScreen` is there because App Store review refuses an iPad app that
restricts its orientations without it. Tauri merges `src-tauri/Info.ios.plist` into the
app's Info.plist on every iOS build. The writer never deletes a file, so the sidecar is
ALWAYS written on iOS, as an empty `<dict>` when nothing is locked: a stale portrait lock
cannot outlive a switch back to `any`. On Android, `any` likewise removes an attribute a
previous build wrote.

**Safe area (iOS).** wry leaves the WKWebView scroll view on `.automatic`, so UIKit shrinks
the page by the safe area (tauri-apps/tauri#8166). The generated `lib.rs` always carries a
`.setup` hook that sets `contentInsetAdjustmentBehavior` to `.never` on the `main` window,
through `objc2`, so the page gets the whole screen and CSS `env(safe-area-inset-*)` still
reports the notch. The hook and the `use tauri::Manager` it needs are `#[cfg(target_os =
"ios")]`, and `objc2 = "0.6"` sits in a `[target.'cfg(target_os = "ios")'.dependencies]`
table: neither adds a per-target difference to `lib.rs` or `Cargo.toml`, and no other
target compiles `objc2`. The window keeps tauri's default `main` label; the generator never sets one.

**Window colour.** `app.backgroundColor` (`#rrggbb` or `#rrggbbaa`) becomes
`app.windows[0].backgroundColor`. It shows during launch and behind any gap the page does
not cover; unset, the platform default stays (white in light mode). On Android it also
picks the status bar icon colour, see [The Android status bar](#the-android-status-bar).

## The mobile patch pass

`patchMobile` runs these patches, in this order, and merges their results into one report
(a file two patches touched is listed once, as patched):

| Platform | Patches |
|---|---|
| android | release signing → main-activity manifest attributes → status bar style → runner command |
| ios | Xcode entitlements-modification setting → runner command |

The runner rewrite runs only when `runner` is passed. The api wrapper hands the Android
pass its manifest entries: every capability's `activity-attribute` entries, then the
orientation lock (last, so it wins a clash). It also hands it `app.backgroundColor`, for
the status bar style.

### The Android status bar

`tauri android init` (cli 2.12) writes a `MainActivity.kt` that calls `enableEdgeToEdge()`.
Its default `SystemBarStyle.auto` picks the icon colour from the phone's night mode, not
from the app: a dark app on a light-mode phone gets dark icons on a dark page. When
`app.backgroundColor` is set, the patch rewrites that one call by the colour's relative
luminance (alpha ignored; below 0.179 is dark, where white and black icons contrast equally):

| `app.backgroundColor` | Call written | Icons |
|---|---|---|
| dark (`"#10161d"`) | `enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))` | light |
| light (`"#ffffff"`) | the same with `SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)` | dark |
| unset | the bare `enableEdgeToEdge()` again | the system's choice |

The styled call adds `import androidx.activity.SystemBarStyle` and
`import android.graphics.Color` after the last import. Going back to unset removes them
again when nothing else in the file uses them, so the generated bytes come back exactly.
Every other byte is kept, CRLF included, and a second pass reports the file unchanged.

The target is the one `MainActivity.kt` below `gen/android/app/src/main/java` that calls
`enableEdgeToEdge(` (build output is never searched). With a colour set, no such file, two
of them, or a call this patch did not write, is a `[native]` error with a fix-it. Without
a colour the patch only restores, and never fails. iOS needs no patch: its status bar
adapts to the page content on its own.

### The runner command

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
| android | `gen/android/buildSrc/**/BuildTask.kt` (Kotlin shape, see below) | the rest of the file | Kotlin literals |

The match is **runner-agnostic but narrow**: on every line carrying ` ios xcode-script` /
` android android-studio-script`, only the runner-shaped token run directly before the verb is
replaced — `<binary> tauri` (optionally path-qualified), `npm run tauri --`, a bare `tauri`, or
an already-absolute quoted pair. A path qualifier never contains a quote or a backslash, so a
path-qualified runner (`/opt/homebrew/bin/node tauri`, written when an absolute node drives
`tauri ios init`) is matched from its first `/`, and the `"` that opens `shellScript = "…"` or
a Kotlin string stays put. Everything else survives byte for byte, including a shell
preamble such as `set -e` / `cd "$SRCROOT" &&` and the verb's own arguments. Each path is
escaped for the double-quoted shell word it lands in (`\`, `"`, `$`, backtick), and a path
containing a line break is refused with a `[native]` error. Omit `runner` and the rewrite is
skipped. The pass is idempotent: a second run rewrites the absolute pair onto itself and reports
every file unchanged — but an absolute pair whose Node path CHANGED (an fnm/nvm switch) is
re-patched, not left stale.

**The Android `BuildTask.kt` shape.** `tauri android init` (cli 2.12) does not write one
command string there. It writes the runner as Kotlin code, which Gradle runs with no shell:

```kotlin
val executable = """/opt/homebrew/bin/node""";
val args = listOf("tauri", "android", "android-studio-script");
```

The rewrite sets the raw-string `executable` to the absolute Node path, and every `listOf`
argument before `"android", "android-studio-script"` (`"tauri"`, npm's `"run", "--", "tauri"`)
to the one absolute `tauri.js` path. The executable is rewritten only in a file that also
has that `listOf`. Each path is escaped for its own Kotlin literal: in the `listOf` string,
`\`, `"` and `$` get a backslash; in the raw `"""…"""` string, which has no backslash
escapes, `$` and `"` become `${'$'}` / `${'"'}` templates and `\` stays as it is.
Everything else in the file is kept byte for byte, and a second pass reports it unchanged.

A file that invokes the verb behind a runner shape the match does **not** recognize is an
error, never an "unchanged" file — reporting success there ships a tree that fails on its
first Xcode/Android-Studio build phase, with nothing in the log pointing back here:

```
[native] Could not find a Tauri runner command before "ios xcode-script" in <file>.
  Set pluginConfigs.tauri.nodePath, or report the runner line Tauri generated.
```

A file whose `listOf` passes `"android", "android-studio-script"` but has no raw-string
`val executable = """…"""` beside it, or passes them outside a `listOf`, gets the same error.
A file that never mentions the verb is simply unchanged.

### The Android manifest

The manifest patch applies `activity-attribute` entries to the main `<activity>` of
`gen/android/app/src/main/AndroidManifest.xml`. Tauri has no config key for what that
element carries, `android:screenOrientation` included.

- **The main activity** is the one whose body declares `android.intent.action.MAIN`. A
  manifest with a single activity and no MAIN still has an obvious one. Comments and
  `<activity-alias>` never count, and a `>` inside a quoted value never ends a start tag.
- **Set** replaces the attribute's value in place, or inserts it as the first attribute,
  with the whitespace that already follows `<activity`: on the template's
  one-attribute-per-line layout that is a new line at the next attribute's indentation.
- **Remove** (`value: undefined`) drops the attribute with the whitespace before it — its
  whole line on that layout.
- Line endings (CRLF included) and every other byte survive; a second pass reports the
  manifest unchanged. Values are XML-escaped.
- `child` entries are not applied: no registry row carries one, and the official plugins
  merge their own manifest needs through build.rs.

With no attribute entry the manifest is not even read. A missing manifest, or an attribute
to SET with zero or several MAIN activities, fails:

```
[native] Could not find the main <activity> in <manifest>.
  Re-run the mobile init pass (tauri android init) or report the manifest Tauri generated.
```

A pass that only REMOVES leaves such a manifest as it is: there is nothing to remove, and
an app that never set an orientation must not start failing on a manifest it never touches.

## iOS rebuilds

A first iOS build of a clean tree passes; the SECOND build of the same tree used to fail
twice over. Both failures are the generated project's, not the app's, so both are patched
here.

**Xcode: the entitlements file.** A capability plugin's build script rewrites
`<app>_iOS.entitlements` while Xcode is compiling, and Xcode refuses:

```
error: Entitlements file "<app>_iOS.entitlements" was modified during the build,
which is not supported
```

`patchMobile({ target: "ios" })` therefore adds the setting Xcode itself names, whether or
not a `runner` is passed:

| File | Where | Written as |
|---|---|---|
| `gen/apple/*.xcodeproj/project.pbxproj` | every `buildSettings = { … }` block, once, at its siblings' indentation | `CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION = YES;` |
| `gen/apple/project.yml` | each target's `settings.base` (never a `settingGroups` block) | `CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION: true` |

`project.yml` carries it so a later xcodegen regeneration writes it back into the pbxproj.
The `base:` mapping is found by walking the `settings:` block, so it is picked up wherever
it sits among its siblings (`groups: [app]` above it included), and a `settings:` block
without one is left alone. Both transforms are pure text: line endings (CRLF included),
indentation and every neighbouring line survive byte for byte, a block that already carries
the setting is left alone — a blank line does not end a YAML mapping, so an entry below one
still counts — and a block that turned it OFF is rewritten to `YES`. A second pass reports
every file unchanged.

**Tauri: the previous build output.** `tauri ios build` renames its fresh `.app` into the
archive the previous build left behind:

```
failed to rename app …/gen/apple/build/<app>_iOS.xcarchive/Products/Applications/<Name>.app:
Directory not empty (os error 66)
```

`clearMobileBuildOutput({ target: "ios" })` removes `gen/apple/build` before the compiler
starts. It is a recursive delete, so it passes the same derived-path gate as `clean()` AND
a containment check: `gen/apple/build` must be a real directory whose REAL path (symlinks
resolved) sits strictly inside the real `projectDir`. The entry is read with `lstat`, so a
DANGLING `build` link reaches the gate instead of passing for a missing directory. A `build`
symlink is refused, never followed:

```
[native] Refusing to remove build output outside projectDir: <real path>.
  Remove that link by hand — "<path>" must be a real directory inside <projectDir>.
```

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
| `app.backgroundColor` | not `#rrggbb` or `#rrggbbaa` |
| `app.orientation` | not `"portrait"`, `"landscape"` or `"any"` — config arrives as plain JS too |
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

### Capability registry (7 rows)

| Capability | Platforms | Backed by | Permissions | Confidence |
|---|---|---|---|---|
| `store` | all 5 | crate + npm package + Rust init | `store:default` | high |
| `notification` | all 5 | crate + npm package + Rust init | `notification:default` | high |
| `clipboard-manager` | all 5 | crate + npm package + Rust init | `clipboard-manager:allow-read-text`, `clipboard-manager:allow-write-text` | high |
| `tray` | desktop only (macos/windows/linux) | **cargo feature `tray-icon`** — no crate, no npm package, no Rust init | `core:tray:default`, `core:menu:default`, `core:image:default`, `core:resources:default`, `core:app:allow-default-window-icon` | low |
| `deep-link` | all 5 (custom-scheme-only, D-011) | crate + npm package + Rust init | `deep-link:default` | high |
| `back` | android only | **core permissions only** — no crate, no npm package, no Rust init | `core:app:allow-exit` | high |
| `haptics` | mobile only (ios/android) | crate + npm package + Rust init | `haptics:allow-impact-feedback`, `haptics:allow-notification-feedback`, `haptics:allow-selection-feedback`, `haptics:allow-vibrate` | high |

`tray` names five permissions because a tray is not just the tray: the icon goes through
`Image`, the menu through `Menu`, and `@moku-labs/system` defaults the icon to
`defaultWindowIcon()`. That last call is the one `core:default` does **not** cover — without
`core:app:allow-default-window-icon` a real macOS shell fails at startup with
`Command plugin:app|default_window_icon not allowed by ACL`. The menu, image and resources
ids are already inside `core:default`; the row lists them anyway so it documents the whole
surface tray touches instead of relying on the baseline set.

`back` grants `exit()` alone. `onBackButtonPress` and `exit` ship in `@tauri-apps/api/app`
itself, the press listener's permissions are already inside `core:default`, and
`core:app:allow-exit` is not even in `core:app:default`. It is Android-only, like `tray` is
desktop-only: the hardware back button exists only there, so every other target-set drops
the row. `exit` and `core:app:allow-exit` exist since tauri 2.12.0, which is why the
generated `Cargo.toml` pins `tauri = { version = "2.12" }`.

`haptics` names its four commands because the plugin ships no default permission set. It
needs no manifest entry: the plugin merges `android.permission.VIBRATE` itself.

`tray` and `back` are the reason every plugin-shaped field on `RegistryRow` is optional while
`cargoFeatures` is required: one is a core Tauri feature flag, the other core permissions
alone, neither a plugin. Consumers of
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
