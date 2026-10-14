# doctor

> Complex plugin — per-target toolchain/completeness/version-skew diagnosis via a `checks/` registry.

Diagnoses whether a target is actually buildable: toolchain presence (rustup/node/Xcode/Android
SDK), mobile `gen/`-tree completeness, `@tauri-apps/*` npm-vs-crate version skew, signing env-var
presence, and a couple of warn-only cross-repo pointers (worker CORS; deep-link `.well-known`).
Checks run in parallel via `Promise.allSettled` — one broken check can never sink the report.

## API

```ts
app.doctor.run(opts?: { target?: Target }): Promise<DoctorReport>
```

```ts
const report = await app.doctor.run({ target: "ios" });
if (!report.ok) process.exitCode = 1;
```

- **`run({ target })`** — runs every check applicable to that one real packaging target.
- **`run()`** (no `target`) — runs every check applicable to each of `config.targets`, plus every
  host-scoped check (`node`, `tauri-cli`, `web-script`, `tauri-version-skew`, `cross-repo-*`) once.

```ts
type DoctorReport = { ok: boolean; checks: readonly CheckResult[] };
type CheckResult = {
  id: string;
  target: Target | "host";
  status: "pass" | "warn" | "fail";
  message: string;         // human line, [native]-prefixed
  fixIt?: string;          // actionable next command/step
};
```

`ok` is `false` only when at least one check's `status` is `"fail"` — a `"warn"` never flips it.

## Events

```ts
"doctor:check": CheckResult   // emitted once per check, AS IT SETTLES (cli renders these live)
```

Emission order is settle order — checks run in parallel, so a fast check emits before a slow one
that was scheduled earlier. `report.checks` keeps the registry order regardless.

## The `checks/` registry (the providers pattern)

Each module in `checks/` exports one (or, for `cross-repo.ts`, two) `Check` — a pure
predicate-plus-message factory over an injected `probe`/`fs`/`env`/`project`/`tauri` seam, never a
raw subprocess/fs call of its own (`fs` is read-only: `readFile`, `exists`, `readdir`):

| Module | Diagnoses | Posture |
|---|---|---|
| `rustup.ts` | rustup present; the target's required rust triple installed | fail |
| `node.ts` | a real `node` binary on PATH, distinct from bun (tauri#9939) | fail |
| `xcode.ts` | Xcode/xcodebuild present, simulators queryable (ios, macOS host only) | fail |
| `ios-tools.ts` | `xcodegen` + `pod` on PATH and both rust triples (`aarch64-apple-ios`, `aarch64-apple-ios-sim`) installed (ios, macOS host only); fix-it lists the exact install commands | fail |
| `ios-platform.ts` | the installed iOS platform: `xcodebuild -showsdks` + `xcrun simctl list runtimes` (ios, macOS host only). Warns only when NO simulator runtime is installed — a runtime newer than the SDK is fine | **warn only** |
| `android.ts` | `ANDROID_HOME`/SDK, NDK, JDK presence (android) | fail |
| `android-platform.ts` | the SDK platform the build compiles against is installed: `platforms/android-N` or the minor-version naming `android-N.0` (a real minor platform such as `android-36.1` is a separate package and does not count), under `ANDROID_HOME` → `ANDROID_SDK_ROOT` → the Android Studio default (`~/Library/Android/sdk` on macOS, `~/Android/Sdk` on linux, `%LOCALAPPDATA%\Android\Sdk` on windows). N is `compileSdk` from the generated `gen/android/app/build.gradle.kts`, else 37 (the tauri-cli 2.11 template). Fix-it: `sdkmanager "platforms;android-N"`. `ANDROID_HOME`/`ANDROID_SDK_ROOT` naming a missing directory **fails** (`android.ts` only sees that the var is set); no env var and no SDK at the default location is a **warn** — `android.ts` already fails for it (android) | fail |
| `android-debug-signing.ts` | the debug keystore `<home>/.android/debug.keystore` (`HOME`, else `USERPROFILE`) a debug build is signed with. The pass names the install steps (`adb install -r <apk>` over a cable; `adb pair` then `adb connect` over Wi-Fi, Android 11+); the warn's fix-it is `mkdir -p <home>/.android && keytool -genkeypair … -alias androiddebugkey`, which doctor never runs (android) | **warn only** |
| `signing.ts` | signing readiness, presence and counts only (never values): one complete Apple credential set (`APPLE_ID`+`APPLE_PASSWORD`+`APPLE_TEAM_ID`, **or** `APPLE_API_KEY`+`APPLE_API_ISSUER`+`APPLE_API_KEY_PATH`), `signing.apple.teamId` for ios, a count-only keychain probe, `signing.android.keystorePasswordEnv` for android, and `signing.windows.certificateThumbprint` for windows | **warn only** |
| `completeness.ts` | mobile `gen/` required-file-set via `project.getCompleteness()`; fix-it is always `native clean --target <t>` | fail (not-initialized = pass) |
| `versions.ts` | `@tauri-apps/*` npm major version vs. the registry-pinned crate range, read from the same root as `web-script.ts`; rows without an npm package (`tray`) are skipped | **warn only** |
| `web-script.ts` | `web.build`/`web.devCommand` scripts exist in the SAME root Tauri will use (`web.cwd` when set, else the consumer root). Only `<pm> run <script>` and the `<pm> <script>` shorthand name a script; a direct command passes unchecked. Necessary-not-sufficient, never executes the script | fail |
| `tauri-cli.ts` | CLI invokable via `tauri.getVersion()` — the one probe routed through `tauri`, not this plugin's own `probeImpl` | fail |
| `cross-repo.ts` | worker CORS must allow `tauri://localhost`/`http://tauri.localhost` (always fires); deep-link `.well-known` pointer (fires only when `deep-link` is composed) | **warn only, always** |

A check's `appliesTo(target, global)` decides whether it participates in a given scope — a real
`Target` for per-target checks, or `"host"` for checks that run once regardless of how many
targets are configured.

## Configuration

```ts
pluginConfigs: {
  doctor: {
    probeImpl?: ProbeFn;      // test seam — default: real spawn (which/--version subprocesses)
    probeTimeoutMs?: number;  // per-check budget, default 10_000
  };
}
```

`probeImpl` is doctor's own subprocess seam for every **non-tauri** binary probe (`rustup`,
`xcodebuild`, `java`, `node`, …). The one tauri-CLI probe (`tauri-cli.ts`) goes through
`app.tauri.getVersion()` instead — the subprocess-seam ownership boundary (`tauri` owns the
`@tauri-apps/cli` seam) stays intact.

`probeTimeoutMs` bounds every check twice over: the real probe hands it to `spawn` as its
`timeout`, and `run()` races each check against it. A check that outruns the budget yields
`[native] doctor check "<id>" timed out.` as a **warn**, reported under the id the check
itself would have produced (`Check.resultId(scope)` — `signing-macos`, not `signing`), so the
row lines up with the live one the cli already printed — a slow toolchain probe is not a broken
toolchain, so it never flips `report.ok`.

## Design notes

- **Depends:** `[project, tauri]` (D-007) — `project` supplies `getRequiredFiles`/
  `getCompleteness`/`getRegistryRows`; `tauri` supplies the one CLI-invokability probe.
  Both APIs are resolved at the wiring point and handed to the api factory as `deps`.
- **No `onInit`/`onStart`/`onStop`** — project owns config validation; the check registry is
  static; checks run only on `run()` calls, nothing outlives one.
- **Signing values never logged** — every signing check reads presence only (`ctx.env.has`), never
  a value (`ctx.env.get`), into any message or fix-it. The keychain probe parses a **count** of
  codesigning identities, never the identity strings; it is skipped when `signing.apple.signingIdentity`
  is unset or `"-"`, or when `APPLE_CERTIFICATE` is set (CI brings its own keychain).
  `android-debug-signing` reads one value, the home directory (`HOME`/`USERPROFILE`), a path
  and never a secret: the debug keystore's passwords are the public `android` defaults.
- **Domain files**: `types.ts` (`DoctorApi`/`DoctorContext`/`DoctorReport`/`CheckResult`), `api.ts`
  (check selection + parallel dispatch + per-check timeout race + emission), `report.ts` (ok
  computation + settled-rejection → internal-error mapping), `checks/` (the check modules + registry).
