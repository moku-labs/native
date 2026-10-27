# project

> Complex plugin — capability registry + `.moku/tauri` generators (the shell plugin crate among them) + write-if-changed writer + mobile init-once-then-patch with build profiles + clean.

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

Two additions reach past packaging. The `shell` capability generates a small Tauri plugin
crate, `tauri-plugin-moku-shell`, that installs the page contract
[`globalThis.__MOKU_NATIVE__` v1](#page-contract-v1) (display rate, thermal state, safe-area
insets, device info). And the [build profiles](#build-profiles) patch the Android tree for an
on-device debug build that installs next to the store app.

## Tier

The plugin is about 7,250 lines of source in 37 files, with `mobile/` and `generators/` as
coordinating sub-domains. It stays **Complex**, not Very Complex, by decision:

- **The API is flat.** One `Api` type in `types.ts`, one `createProjectApi` factory; the
  sub-domains are reached through it, never through namespaced `api.mobile.*` /
  `api.generators.*` slices.
- **The sub-domains are stateless.** `mobile/` and `generators/` are plain functions over
  files and the frozen global config. Neither owns state, config or events, so neither needs
  the `types.ts` / `state.ts` / `api.ts` module directory of the Very Complex tier.
- **That is the Complex shape in spec/15 §2.4-2.5**: Standard files plus subdirectories for
  sub-domains. Very Complex is for coordinating modules that each own state and an API.

The size alone does not re-open the decision; a sub-domain that gains its own state or a
namespaced API slice does.

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
| `page-agent.ts` | the editor-agent scan of the built page (`detectPageAgent`) |
| `paths.ts` | **the one owner of path normalization/containment** — realpath resolution, case rules, the project-anchor walk, and the "is this derived state?" / "may we deliver here?" predicates shared by `clean.ts`, `validate.ts` and (via the API) `build`'s collect guard |
| `generators/*.ts` | one generated artifact each (see the table below) |
| `generators/shell/*.ts` | the shell plugin crate: `rust.ts` (Cargo.toml, build.rs, lib.rs, permissions), `page-script.ts` (the page contract), `android.ts` (the Kotlin library module), `index.ts` (orchestration) |
| `mobile/completeness.ts` | the `gen/<platform>` required-file set and the completeness gate |
| `mobile/files.ts` | **the one owner of which generated files a patch may touch** — never anything under `gen/*/build` |
| `mobile/profile.ts` | the build-profile patches: the Gradle profile block, the debug app name in `strings.xml`, the debug network security config |
| `mobile/signing.ts` | the Android release-signing block in `app/build.gradle.kts` (the debug keystore in the debug profile) |
| `mobile/manifest.ts` | the main `<activity>` and the `<application>` attributes in `app/src/main/AndroidManifest.xml` |
| `mobile/icon.ts` | the adaptive icon inset in `res/mipmap-anydpi-v26/ic_launcher*.xml` |
| `mobile/shell-link.ts` | the check that the shell plugin is linked into `gen/android` |
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
| `plugins/moku-shell/**` | `generators/shell/*.ts` | only when `shell` is composed for the target: the `tauri-plugin-moku-shell` crate (`Cargo.toml` with `links`, `build.rs`, `src/lib.rs`, `src/page.js`, `permissions/default.toml`) and its Android module (`android/build.gradle.kts`, manifest, R8 rules, `MokuShellPlugin.kt`, the per-profile `MokuShellProfile.kt`) |

Without the shell, nothing is written under `plugins/`, and the output is byte for byte what
it was before the shell existed, in both profiles. With it, `Cargo.toml` gains
`tauri-plugin-moku-shell = { path = "../plugins/moku-shell" }`, `lib.rs` gains
`.plugin(tauri_plugin_moku_shell::init())`, and the capability file gains `moku-shell:default`.
`build.rs` and `default.toml` are generated from one list of six commands (`set_frame_rate`,
`thermal`, `insets`, `log`, `share`, `info`), so a granted command always exists.

Path fields (`build.frontendDist`, `bundle.macOS.entitlements`) are rebased onto
`src-tauri` in POSIX form, because that is where Tauri resolves them from.
`beforeDevCommand`/`beforeBuildCommand` use the object form with an explicit `cwd`, so a
monorepo consumer's web build runs in its own package.

## API

```ts
app.project.generate({ target: "macos" }); // profile defaults to "store"
app.project.generate({ target: "android", profile: "debug" });
// => { written: string[], unchanged: string[], skipped: string[] }

app.project.getCompleteness({ target: "android" });
// => { status: "not-applicable" | "not-initialized" | "incomplete" | "complete", missing?: string[] }

app.project.getBundleLayout({ target: "macos" });
// => { root: "src-tauri/target/release", formats: [{ directory, pattern }], genDirectory?: string }

await app.project.patchMobile({ target: "ios", runner: app.tauri.getRunner() });
await app.project.patchMobile({ target: "android", runner: app.tauri.getRunner(), profile: "debug" });
// => { patched: string[], unchanged: string[] }

await app.project.patchMobileIcons({ target: "android" }); // after `tauri icon`
// => { patched: string[], unchanged: string[] }

await app.project.detectPageAgent();
// => { agent: true, file: "page/main-4f2a.js" } | { agent: false }

await app.project.checkShellLinked({ target: "android", profile: "debug" }); // after the compile

await app.project.ensureIconSource();
// => absolute path to the 1024x1024 source PNG for `tauri icon`

await app.project.clean({ target: "android" }); // omit target to clean the whole projectDir
// => { removed: string[] }

app.project.resolve("deep-link", { mode: "scheme", scheme: "myapp" });
// => ResolvedCapability (registry row + conf/sidecarPlist/manifest)

app.project.isKnownCapability("store"); // => true
app.project.getRegistryRows(); // => copies of the 8 registry rows (consumed by doctor)
app.project.getRequiredFiles({ target: "android" }); // => required gen/android file set (consumed by doctor)
app.project.getDebugKeystore();
// => { path: "/home/me/.android/debug.keystore" | undefined, createCommand: 'mkdir -p "…" && keytool …' } (consumed by doctor)
```

- `generate({ target, profile? })` — writes/refreshes every pure artifact for a target into
  `projectDir` via write-if-changed. Desktop targets get the whole tree; mobile targets
  get the shared tree + conf (the `gen/` tree itself is created by `tauri android/ios
  init`, never by this plugin). When `shell` is composed, the shell crate too, with the
  profile baked into its page script. `profile` defaults to `"store"`.
- `getCompleteness({ target })` — mobile `gen/<platform>` required-file-set gate. Desktop
  targets are `"not-applicable"`.
- `getBundleLayout({ target })` — where that target's build output lands: the output root,
  the desktop bundle-format directories with their artifact globs, and the mobile
  `gen/<platform>` directory. `build`'s collect phase globs against this instead of keeping
  its own copy of the table, so the layout has exactly one owner (`layout.ts`).
- `patchMobile({ target, runner?, profile? })` — idempotent post-init patch pass, see below.
- `patchMobileIcons({ target })` — the [adaptive icon inset](#adaptive-icon-inset); iOS gets an
  empty result.
- `detectPageAgent()` — scans the built page for the editor agent, see
  [The page agent](#the-page-agent).
- `checkShellLinked({ target, profile? })` — fails when the shell is composed but not linked
  into `gen/android`, see [Build profiles](#build-profiles).
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
- `getDebugKeystore()` — the Android SDK debug keystore the debug profile signs with
  (`<home>/.android/debug.keystore`, home from `HOME`, else `USERPROFILE`) and the
  `mkdir -p … && keytool …` command that creates it. Never throws and never touches the
  filesystem; doctor's debug-keystore check reads it instead of keeping its own copy of the rule.

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
| android | build profile → release signing → main-activity manifest attributes → status bar style → runner command |
| ios | Xcode entitlements-modification setting → runner command |

The profile patches run first, so the store profile cuts its Gradle block out byte for byte
wherever the signing block sits; see [Build profiles](#build-profiles).

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
`gen/android/app/src/main/AndroidManifest.xml`, and `application-attribute` entries to its
`<application>` start tag (the debug profile's `android:networkSecurityConfig`). Tauri has no
config key for what those elements carry, `android:screenOrientation` included. Both kinds
follow the same set / replace / remove rules below.

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

## Build profiles

`generate`, `patchMobile` and `checkShellLinked` take a `profile`: `"store"` (the default, the
shippable build) or `"debug"` (an on-device test build, Android only — `build` refuses debug
for other targets). The debug build stays a **release** build type, Rust and Gradle optimized,
so measurements on the phone match the store app (Decision D1). Every patch is idempotent, and
the store profile restores the bytes the tree had before the debug profile touched it.

| What | Debug profile | Store profile |
|---|---|---|
| `app/build.gradle.kts` | `// MOKU-PROFILE-START … // MOKU-PROFILE-END` block: `applicationIdSuffix = ".debug"` on the release build type, so the debug app installs beside the store app | the block cut out, bytes restored exactly |
| signing | the SDK debug keystore, see [Signing](#signing) | the configured store keystore, as before |
| `res/values/strings.xml` | `app_name` and `main_activity_title` become `"<app.name> (debug)"`, escaped for aapt2 (`\'`, `\"`, `\\`, a leading `\@`/`\?`, `&amp;`, `&lt;`), after a `<!-- moku:native debug name <n> … -->` comment that keeps the original lines and the count `n` of renamed lines after it (a multi-line element is renamed onto one line) | touched only when that comment is there: the original lines come back. A tree never built in debug is not even written |
| `res/xml/network_security_config.xml` | written, first line `<!-- moku:native debug profile -->`, `<base-config cleartextTrafficPermitted="true" />`: cleartext to every host, so `ws://` reaches the editor over `adb reverse` and on the LAN (Decision D4b). A hand-made config it replaces is kept inside it (base64, `<!-- moku:native kept file … -->`), with a `ctx.log.warn` | a moku config is undone: the hand-made file it replaced is written back byte for byte, or the file is deleted when there was none. A config this plugin did not write is left alone, with a `ctx.log.warn` (Decision D4) |
| `<application android:networkSecurityConfig>` | `"@xml/network_security_config"`; a previous value is kept in the moku config (`<!-- moku:native kept attribute … -->`) | restored to that previous value, or removed when there was none. Next to a config this plugin did not write, left alone |
| the shell | composed even when `system` does not name it | only when `system` names it |
| the page | `build.profile === "debug"`, console forwarded to logcat, WebView debugging on, `share` present | `build.profile === "release"`, console untouched, no `share` |

Line endings follow the patched file (CRLF included). The debug label and the restore both
work on whole lines, so a name with `'`, `&` or `--` round-trips.

**The link check.** The Tauri CLI writes `gen/android/tauri.settings.gradle` from every
plugin's Android library. A tree initialised before the shell was added may not name it, and
then every `__MOKU_NATIVE__` call fails at runtime with no build error. `checkShellLinked`
therefore runs after the compile, whenever the shell is composed for the target and profile:

```
[native] the shell plugin is not linked into gen/android (tree initialised before the shell was added).
  Run clean for android and build again.
```

Whether `tauri android build` regenerates that file, or only `tauri android init` does, is
still unverified (research Q1); the first real build of an existing tree answers it.

## Page contract v1

The shell's init script runs before page scripts, in the main frame (Tauri 2.12 injects
plugin init scripts there only; an iframe may lack `__TAURI_INTERNALS__` anyway), and installs
a frozen `globalThis.__MOKU_NATIVE__`. A browser, iOS (shell deferred) or an app without the shell has
none, and an engine that finds none keeps its old behaviour. A second run in the same frame is
a no-op. IPC goes through `window.__TAURI_INTERNALS__.invoke`, present in every Tauri page.

```ts
type MokuNative = {
  version: 1;
  platform: "android";
  build: { profile: "debug" | "release"; id: string }; // id "<app.version>+<app.buildNumber ?? 0>", "-debug" in debug
  device: { model: string; manufacturer: string; sdk: number } | null; // null until `ready`
  ready: Promise<void>; // resolves when the one `info` call answered, or failed — never rejects
  display: {
    maxHz: number | null; // the panel's top rate at the current resolution, null until `ready`
    setFrameRate(fps: number | null): Promise<{ panelHz: number | null; maxHz: number | null }>;
  };
  thermal: {
    read(): Promise<{
      status: "none" | "light" | "moderate" | "severe" | "critical" | "emergency" | "shutdown";
      headroom: number | null; // ADPF, 10 s forecast, cached for 1 s, NaN → null
      at: number;
      android?: { status: number; headroom: number | null; forecastSeconds: 10 };
    }>;
  };
  insets: { readonly current: { top: number; right: number; bottom: number; left: number } }; // CSS px
  share?(file: { name: string; mime: string; bytes: Uint8Array }): Promise<{ shared: boolean }>; // debug only
};
```

- `setFrameRate(fps)` picks the display mode at the current resolution with the slowest rate
  at or above `fps` (none: the fastest), through the window's preferred display mode; `null`
  restores the system default. A non-positive or non-finite `fps` rejects with a `TypeError`
  before the shell is called. The same preference again changes nothing.
- `share` exists only in the debug profile (feature-detect with `"share" in shell`). It
  rejects with a `TypeError`, before calling the shell, a name that is empty, contains `/` or
  `\`, or is dot-only, and more than 32 MiB of bytes. The bytes travel base64-encoded; the
  shell writes them to `cacheDir/moku-share/<name>` and opens the share sheet.
- In the debug profile, `console.log|info|warn|error|debug` still run and also reach logcat
  under the tag `moku-page` (arguments stringified, objects as JSON, at most 4000 characters).

**Events and CSS.** The shell pushes through `globalThis.__MOKU_NATIVE_PUSH__`:

| Push | On the page |
|---|---|
| `insets` (status bars and cutout for top/left/right, navigation bars and cutout for bottom, in dp) | `--moku-device-safe-top`, `--moku-device-safe-right`, `--moku-device-safe-bottom`, `--moku-device-safe-left` (`<n>px`) on `document.documentElement.style`, `insets.current` updated, then `moku-native:insets` dispatched on `window` with the insets as `detail` |
| `thermal` (every thermal status change, API 29+) | `moku-native:thermal` dispatched on `window`, `detail` = the full thermal reading |

The script also asks for the last insets once at start, so a push that came before it is not
lost. Pages read them as
`var(--moku-safe-top, var(--moku-device-safe-top, env(safe-area-inset-top)))`, the chain of
`@moku-labs/game`. The shell writes `--moku-device-safe-*` and not `--moku-safe-*`: a property
in the root's `style` attribute beats every stylesheet rule, so a page that sets `--moku-safe-*`
itself from the insets (the insets plus a gap of its own) keeps its rule. The editor writes the
same four properties for a device preset in its iframe.

**iOS.** Deferred (Decision D6). WKWebView caps `requestAnimationFrame` at 60 Hz on ProMotion
with no public API, so a future iOS shell will answer `setFrameRate` with
`{ panelHz: 60, maxHz: 60 }`.

### WebView origin per platform

| Platform | `location.origin` of the packaged page |
|---|---|
| Android | `http://tauri.localhost` (Tauri 2 default, `useHttpsScheme` false) — the e2e station confirms it on the A26 |
| Windows | `http://tauri.localhost` |
| iOS, macOS, Linux | `tauri://localhost` |

The `http://<scheme>.localhost` form exists only on Windows and Android, where the WebView
cannot register a custom scheme; everywhere else the page is served from `tauri://localhost`.

## Adaptive icon inset

`app.adaptiveIconInset` (percent per side of the 108 dp canvas, `0 < n ≤ 30`) keeps
full-bleed launcher art inside the mask: `19.44` keeps it in the 66 dp safe zone.
`patchMobileIcons` rewrites the foreground of `res/mipmap-anydpi-v26/ic_launcher.xml` and
`ic_launcher_round.xml`:

```xml
<foreground android:drawable="@mipmap/ic_launcher_foreground"/>
<!-- becomes -->
<foreground><inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="19.44%"/></foreground>
```

`tauri icon` rewrites these files, so `build` calls it after its icons phase on every build.
A second pass is a no-op (never a nested `<inset>`), a new value replaces the old one, and an
unset inset restores the plain foreground. No directory yet: nothing to do.

## The page agent

`detectPageAgent()` scans every `.js` file under `<web.cwd ?? .>/<web.dist>` — UTF-8, one at a
time, in name order — for `"/__editor/hello"` or `"[moku-editor]"`, the two strings the
engine's own release refusal uses (engine spec 10 §R). The first hit is
`{ agent: true, file: <path relative to the dist> }`; a clean or missing dist is
`{ agent: false }`. Source maps and HTML are never read, and a symlink is followed only when
its target is inside the dist. `build` refuses a store build whose page carries the agent.

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

In the debug profile the release build is signed with the SDK debug key instead:
`<home>/.android/debug.keystore` (`home` is `HOME`, or `USERPROFILE` when `HOME` is unset or
empty, read through `ctx.env`), alias `androiddebugkey`, password `android` (the SDK's public defaults).
The store keystore is never named in a debug build, and the next store pass writes the store
block back in place. A missing debug keystore fails before anything is written:

```
[native] debug keystore not found at <path>.
  Create it with: mkdir -p "<home>/.android" && keytool -genkeypair -v -keystore "<path>" -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US".
```

The path and that command come from one rule, `getDebugKeystore()`: doctor's debug-keystore
check reads the same `{ path, createCommand }`, so the check and the build never disagree on
which keystore signs a debug build. Without a home directory `path` is undefined and the
command names an unquoted `~/.android`.

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
| `macosMinimumSystemVersion` / `iosMinimumSystemVersion` | `bundle.{macOS,iOS}.minimumSystemVersion`; iOS defaults to `"15.0"` when unset, because Tauri's 14.0 default is below Xcode 27's floor and fails every iOS build |
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
| `app.adaptiveIconInset` | not a finite number with `0 < n ≤ 30` |
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

### Capability registry (8 rows)

| Capability | Platforms | Backed by | Permissions | Confidence |
|---|---|---|---|---|
| `store` | all 5 | crate + npm package + Rust init | `store:default` | high |
| `notification` | all 5 | crate + npm package + Rust init | `notification:default` | high |
| `clipboard-manager` | all 5 | crate + npm package + Rust init | `clipboard-manager:allow-read-text`, `clipboard-manager:allow-write-text` | high |
| `tray` | desktop only (macos/windows/linux) | **cargo feature `tray-icon`** — no crate, no npm package, no Rust init | `core:tray:default`, `core:menu:default`, `core:image:default`, `core:resources:default`, `core:app:allow-default-window-icon` | low |
| `deep-link` | all 5 (custom-scheme-only, D-011) | crate + npm package + Rust init | `deep-link:default` | high |
| `back` | android only | **core permissions only** — no crate, no npm package, no Rust init | `core:app:allow-exit` | high |
| `haptics` | mobile only (ios/android) | crate + npm package + Rust init | `haptics:allow-impact-feedback`, `haptics:allow-notification-feedback`, `haptics:allow-selection-feedback`, `haptics:allow-vibrate` | high |
| `shell` | android only (iOS deferred, D6) | **generated local crate** `tauri-plugin-moku-shell` (`localCrate`, linked by path) + Rust init, no npm package | `moku-shell:default` | medium |

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

`shell` is composed like every capability, by naming it in `config.system`
(`system: [{ name: "shell" }]`); `capabilities.shell` is its empty parameter object and
composes nothing on its own. The one exception is the debug profile, which composes the shell
on android even unnamed (console forwarding and WebView debugging live there). A row carries
`crate` + `crateRange` or `localCrate`, never both. On iOS the row is filtered out like any
platform-limited row: the page has no `__MOKU_NATIVE__` there.

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
