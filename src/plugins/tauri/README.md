# tauri

> Standard plugin — `@tauri-apps/cli` subprocess seam: argv builders, injectable spawn, process-group dev lifecycle, stream parsing, error taxonomy, secret scrubbing.

The **only** plugin in this framework that spawns processes. Every other plugin (`build`,
`doctor`, `cli`) reaches the `@tauri-apps/cli` binary exclusively through `app.tauri`.

Invocation shape (D-013): `[nodePath, tauriJsPath, verb, ...args]` — an explicit real `node`
binary (PATH-walked, never `process.execPath`, since that's `bun` in this framework) against
`require.resolve("@tauri-apps/cli/tauri.js")`. Never `bunx tauri`, never a `--bun`-forced
runtime, never the platform `.node` addon directly.

## API

```ts
app.tauri.icon({ source: "assets/icon.png" }): Promise<RunResult>
app.tauri.build({ target, simulator?, exportMethod?, aab?, onTick?, onOutput? }): Promise<RunResult>
app.tauri.mobileInit({ target: "ios" | "android" }): Promise<RunResult>
app.tauri.dev({ target?, onOutput? }): Promise<DevHandle>
app.tauri.getVersion(): Promise<{ cliVersion: string } | null>
app.tauri.getRunner(): { nodePath: string; tauriJsPath: string }
```

- **`icon`** — regenerates the icon set from a source image (`tauri icon`), always with an
  explicit `--output <projectDir>/src-tauri/icons`: without it the CLI writes relative to its own
  cwd, which is not the generated project.
- **`build`** — runs `tauri build` / `tauri ios|android build` for the target. Streams every
  output line through the entropy-gated scrubber before it reaches `onOutput`/a log; `onTick`
  receives parsed compile progress (`"Compiling <crate> vX"`, optionally with cargo's `[N/M]`
  unit-progress prefix) — never a synthesized percentage. Throws a classified `TauriError` on a
  non-zero exit. Build options:

  | Option | Targets | Effect on the argv |
  |---|---|---|
  | `target` | all | `build` (desktop), `ios build`, `android build` — always with `--ci` |
  | `simulator` | ios | `--target aarch64-sim` (`x86_64` on an Intel host). Suppresses `--export-method` — a simulator build is never exported |
  | `exportMethod` | ios | `--export-method app-store-connect \| release-testing \| debugging` on a device build |
  | `aab` | android | `--aab` (store bundle) instead of the default `--apk` (installable) |

  An option a target does not use is ignored, never an error — the `build` plugin forwards the
  app's whole signing/artifact configuration for every target.
- **`mobileInit`** — runs `tauri ios|android init`, the ONLY init verbs this plugin exposes
  (plain `tauri init` is never used — the desktop tree is project-generated). Callers must check
  `project.getCompleteness()` is `"not-initialized"` first; this call is not idempotent
  (tauri#13902).
- **`runner`** — the resolved `{ nodePath, tauriJsPath }` pair every verb spawns with.
  `tauri ios init` bakes whichever runner it *detected* (`node tauri`, `bun tauri`,
  `npm run tauri --`, …) into the generated Xcode project, and none of those resolve inside
  Xcode; `project.patchMobile({ target, runner })` rewrites it with this pair, so the Xcode build
  phase invokes the very same CLI this plugin does.
- **`dev`** — starts the long-lived dev verb (`tauri dev` / `tauri ios|android dev`). Spawns a
  detached process group, installs `SIGINT`/`SIGTERM` handlers (group-kill + handler removal on
  exit), and returns immediately with a `DevHandle`:
  ```ts
  type DevHandle = {
    url: string;                                        // ctx.global.web.devUrl
    ready: Promise<void>;                                // resolves once devUrl responds (poll)
    exited: Promise<{ code: number | null; signal: string | null }>;
    stop(): Promise<void>;                               // group-kill; idempotent
  };
  ```
  There is no stdout "ready" marker (tauri#4740) — `ready` resolves from a `devUrl` readiness
  poll (each probe bounded by a 2s fetch timeout) and rejects, reaping the process group, if the
  configured timeout elapses first. It also rejects the moment the session is over —
  `[native] dev session stopped before the dev server became ready.` — so Ctrl-C or a dev
  process that died on a taken port never polls out the full window. A second
  concurrent `dev()` call throws `[native] tauri dev already running`. Every dev-process output
  line runs through the same entropy-gated scrubber as the one-shot verbs before reaching
  `onOutput` (the render seam `cli`'s dev verb consumes) or the debug log — no output path
  bypasses the scrub pipeline.
- **`version`** — probes CLI presence/version via `tauri info` (used by `doctor`). Returns `null`
  when the CLI can't be invoked, rather than throwing.

Non-zero one-shot exits throw a `TauriError` carrying the scrubbed output tail and an actionable
`[native]`-formatted message. Patterns are tested **per line**, against **both** streams
(scrubbed stdout + stderr — xcodebuild writes the cause to stdout), most-specific-first:

| Kind | Matched on | Fix-it line |
|---|---|---|
| `xcode-script-failed` | `PhaseScriptExecution … Build\ Rust\ Code` | `native clean --target ios`, rebuild, check the runner line in `gen/apple/project.yml` |
| `signing-failed` | `codesign`, `no signing certificate`, `provisioning profile`, `notariz*`, `keychain`, `signtool`, `jarsigner`, `keystore` | check certificates/keystore/keychain, run `native doctor` |
| `toolchain-missing` | `command not found`, `xcode-select`, `ANDROID_HOME`, `ndk not found`, `rustup`, `cargo: not found` | install the platform toolchain, run `native doctor` |
| `platform-missing` | `… is not installed. Please download and install the platform`, `Found no destinations` | `xcodebuild -downloadPlatform iOS`, then `native doctor` |
| `device-unavailable` | `no devices found`, `device not found`, `simulator not booted`, `no emulators found` | connect a device or boot a simulator |
| `config-invalid` | `failed to parse/read …tauri.conf`, `invalid config`, `schema validation failed` | check the generated `tauri.conf.json` |
| `compile-failed` | `error[E0001]`, `could not compile`, `compilation failed` | fix the source and retry |
| `cancelled` | no pattern matched and the exit code is `null` (signal) | — |
| `unknown` | nothing matched | inspect the output tail |

`xcode-script-failed` sits ahead of `signing-failed` and `compile-failed`: the Xcode "Build Rust
Code" phase failing is a runner/toolchain problem inside Xcode, and neither of those fix-its
helps. `platform-missing` sits ahead of `device-unavailable` for the same reason: a missing iOS
SDK platform reports both (`Found no destinations … No devices found`), and only the download
fix-it helps. `config-invalid` is anchored to a failure verb so an ordinary `tauri.conf.json`
mention in progress output is not classified as a config error.

Only **signal lines** (the ones the `stderrTail` section lists) are classified: a 50k-line
xcodebuild log narrates `CodeSign <path>` and exports the whole keychain environment, and one
such incidental mention must never decide the taxonomy for the build.

Lines matching `^\s*Warn\b` are excluded from classification entirely. Every unsigned iOS
simulator build prints `Warn No code signing certificates found …`, which is harmless — matching
it would bucket *every* iOS failure as `signing-failed`. `no code signing` is deliberately not a
signing pattern; a real refusal says `No signing certificate "…" found` or
`requires a provisioning profile`.

### `stderrTail`

A plain "last 20 lines" tail is useless for xcodebuild: those lines are a simulator destination
list, while the cause sits hundreds of lines earlier. The tail is built instead as

1. the **last 15 signal lines** of the scrubbed output — lines matching
   `\berror\b[: ]`, `^\s*Error\b`, `panicked`, `cannot find`, `not found`, `no <x> found`,
   `not installed`, `PhaseScriptExecution`, `failed` — de-duplicated, in original order,
   skipping `export …` environment dumps and `*_ERROR` / `WARNINGS_AS_ERRORS` build-setting
   echoes. The last ones, not the first: a long build restates its early warnings while the
   failure that stopped it is at the end;
2. a `…` separator line (omitted when nothing looked like a cause);
3. the **last 10 lines** verbatim.

## Configuration

```ts
pluginConfigs: {
  tauri: {
    spawnImpl?: SpawnFn;          // test seam — default: real detached-process-group spawn
    nodePath?: string;            // explicit override — default: PATH-walk resolution
    readiness: {                  // devUrl readiness poll (dev() only)
      intervalMs: number;         // default: 250
      timeoutMs: number;          // default: 60_000
    };
  };
}
```

`spawnImpl` and `nodePath` are test/override seams only — production behavior always resolves a
real `node` binary and spawns through `@tauri-apps/cli/tauri.js`. Everything else this plugin
needs (`projectDir`, `web.devUrl`, `signing`) comes from the framework's global `Config`.

## Design notes

- **NO `onStop`** (D-002): a regular plugin's `onStop` receives only `{ global }` — it cannot
  reach `ctx.state`, so it could never tear down a live dev session. Teardown is owned entirely
  by the dev seam's own control flow instead: signal handlers installed at spawn time,
  `handle.stop()` for explicit teardown, and cleanup on natural process exit. This also covers
  Ctrl-C, where `onStop` would never fire anyway.
- **Secret scrubbing** — every subprocess output line is routed through `scrub.ts` before it
  reaches a log, a callback, or a thrown error. Four passes, in order:

  | Pass | Masks |
  |---|---|
  | known env-var names | `APPLE_PASSWORD`, `APPLE_CERTIFICATE*`, `TAURI_SIGNING_*`, `ANDROID_KEY*_PASSWORD`, whatever the value's entropy. A quoted value is captured whole, so a password with spaces does not leak its tail |
  | URL userinfo | `scheme://user:token@host` → `scheme://[native:scrubbed]@host`, always — a URL is location-shaped and would otherwise be exempt |
  | long hex runs | a standalone run of ≥ 32 hex characters (digests, keys); hex tops out at exactly 4 bits/char, so the entropy pass can never reach it |
  | Shannon entropy | any remaining token ≥ 20 chars above 4 bits/char |

  A location-shaped token (one carrying `/`, `\` or `::`) is not exempt from the entropy pass —
  it is scanned **segment by segment**, so `/var/tmp/<secret>/App.dmg` loses only the secret
  while the path stays readable. Three things stay readable by name: canonical 8-4-4-4-12 UUIDs
  plus a short `key:` prefix (roughly half of all UUIDs clear the entropy bar, which turned
  `id:41E558D0-…` in every simulator destination list into a mask), the cargo registry's
  `index.crates.io-<hash>` segment, and a git sha announced by `commit `, `rev ` or `#`.
  Everything is applied AFTER the known-name pass, so `APPLE_API_KEY_PATH=/Users/…` is still
  masked whole.
- **Group signal only when we made the group** — `dev` spawns `detached`, so its child is a
  process group leader and SIGTERM/SIGKILL go to the negated pid, reaping tauri's own
  cargo/xcodebuild/gradle children with it. One-shot verbs spawn attached: the child shares this
  process's group, so signalling `-pid` would hit an unrelated group or fail with ESRCH inside an
  abort handler (an unhandled rejection). Those are signalled by plain pid. Both signals are
  best-effort — a process that exited a microsecond earlier must not fail a teardown — and the
  SIGKILL rung waits a short settle window for the exit instead of claiming the process is gone
  the instant the signal is sent.
- **`close`, not `exit`** — a run resolves when the child's stdio pipes close, not when the
  process exits. tauri's own children (xcodebuild, gradle, cargo) inherit those pipes and keep
  writing after the parent is gone; resolving on `exit` drops exactly the tail an error message
  is made of. The group-kill ladder still watches `exit`.
- **cwd fallback** — one-shot verbs run in `projectDir` once it exists, else in the consumer's
  cwd: `icon`/`version` legitimately run before `scaffold` created it, and spawning into a
  missing directory would fail with a bare `ENOENT`. `dev` always needs the generated project.
- **Domain files**: `argv.ts` (pure per-verb argv builders), `resolve.ts` (nodePath/tauriJsPath
  resolution), `spawn.ts` (real process-group spawn + group-kill escalation), `dev.ts` (dev
  orchestration: signal handlers + readiness poll), `stream.ts` (line splitting + compile-tick
  parsing), `errors.ts` (exit-code/stderr taxonomy), `scrub.ts` (secret masking), `api.ts`
  (composition).
