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
app.tauri.version(): Promise<{ cliVersion: string } | null>
app.tauri.runner(): { nodePath: string; tauriJsPath: string }
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
  `project.completeness()` is `"not-initialized"` first; this call is not idempotent
  (tauri#13902).
- **`runner`** — the resolved `{ nodePath, tauriJsPath }` pair every verb spawns with.
  `tauri ios init` writes a literal `node tauri ios xcode-script` into the generated Xcode
  project, and that command does not exist; `project.patchMobile({ target, runner })` rewrites it
  with this pair, so the Xcode build phase invokes the very same CLI this plugin does.
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
  poll and rejects (reaping the process group) if the configured timeout elapses first. A second
  concurrent `dev()` call throws `[native] tauri dev already running`. Every dev-process output
  line runs through the same entropy-gated scrubber as the one-shot verbs before reaching
  `onOutput` (the render seam `cli`'s dev verb consumes) or the debug log — no output path
  bypasses the scrub pipeline.
- **`version`** — probes CLI presence/version via `tauri info` (used by `doctor`). Returns `null`
  when the CLI can't be invoked, rather than throwing.

Non-zero one-shot exits throw a `TauriError` carrying the scrubbed stderr tail and an actionable
`[native]`-formatted message. `errors.ts` matches the taxonomy most-specific-first:

| Kind | Matched on | Fix-it line |
|---|---|---|
| `signing-failed` | `no code signing`, `codesign`, `provisioning profile`, `notariz*`, `keychain`, `signtool`, `jarsigner`, `keystore` | check certificates/keystore/keychain, run `native doctor` |
| `toolchain-missing` | `command not found`, `xcode-select`, `ANDROID_HOME`, `ndk not found`, `rustup`, `cargo: not found` | install the platform toolchain, run `native doctor` |
| `platform-missing` | `… is not installed. Please download and install the platform`, `Found no destinations` | `xcodebuild -downloadPlatform iOS`, then `native doctor` |
| `device-unavailable` | `no devices found`, `device not found`, `simulator not booted`, `no emulators found` | connect a device or boot a simulator |
| `config-invalid` | `failed to parse/read …tauri.conf`, `invalid config`, `schema validation failed` | check the generated `tauri.conf.json` |
| `compile-failed` | `error[E0001]`, `could not compile`, `compilation failed` | fix the source and retry |
| `cancelled` | no pattern matched and the exit code is `null` (signal) | — |
| `unknown` | nothing matched | inspect the stderr tail |

`platform-missing` sits ahead of `device-unavailable` on purpose: a missing iOS SDK platform
reports both (`Found no destinations … No devices found`), and only the download fix-it helps.
`config-invalid` is anchored to a failure verb so an ordinary `tauri.conf.json` mention in
progress output is not classified as a config error.

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
  reaches a log, a callback, or a thrown error: known secret env-var names (`APPLE_PASSWORD`,
  `APPLE_CERTIFICATE*`, `TAURI_SIGNING_*`, …) are always masked; any other sufficiently long,
  high-entropy token is masked too (Shannon entropy, not a fixed denylist). Tokens containing a
  path separator or `::` are exempt from the entropy pass — cargo registry paths, temp dirs,
  artifact paths, URLs and panic backtraces all clear the entropy bar, and masking them would
  delete the only actionable part of a build failure. The exemption is applied AFTER the
  known-name pass, so `APPLE_API_KEY_PATH=/Users/…` is still masked.
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
