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
app.tauri.build({ target, onTick?, onOutput? }): Promise<RunResult>
app.tauri.mobileInit({ platform: "ios" | "android" }): Promise<RunResult>
app.tauri.dev({ target?, onOutput? }): Promise<DevHandle>
app.tauri.version(): Promise<{ cliVersion: string } | null>
```

- **`icon`** — regenerates the icon set from a source image (`tauri icon`).
- **`build`** — runs `tauri build` / `tauri ios|android build` for the target. Streams every
  output line through the entropy-gated scrubber before it reaches `onOutput`/a log; `onTick`
  receives parsed compile progress (`"Compiling <crate> vX"`, optionally with cargo's `[N/M]`
  unit-progress prefix) — never a synthesized percentage. Throws a classified `TauriError` on a
  non-zero exit.
- **`mobileInit`** — runs `tauri ios|android init`, the ONLY init verbs this plugin exposes
  (plain `tauri init` is never used — the desktop tree is project-generated). Callers must check
  `project.completeness()` is `"not-initialized"` first; this call is not idempotent
  (tauri#13902).
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

Non-zero one-shot exits throw a `TauriError` classified by `errors.ts` into one of:
`"toolchain-missing" | "config-invalid" | "compile-failed" | "signing-failed" |
"device-unavailable" | "cancelled" | "unknown"`, each carrying the scrubbed stderr tail and an
actionable `[native]`-formatted message.

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
  high-entropy token is masked too (Shannon entropy, not a fixed denylist).
- **Domain files**: `argv.ts` (pure per-verb argv builders), `resolve.ts` (nodePath/tauriJsPath
  resolution), `spawn.ts` (real process-group spawn + group-kill escalation), `dev.ts` (dev
  orchestration: signal handlers + readiness poll), `stream.ts` (line splitting + compile-tick
  parsing), `errors.ts` (exit-code/stderr taxonomy), `scrub.ts` (secret masking), `api.ts`
  (composition).
