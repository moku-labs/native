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
"doctor:check": CheckResult   // emitted once per completed check (cli renders these live)
```

## The `checks/` registry (the providers pattern)

Each module in `checks/` exports one (or, for `cross-repo.ts`, two) `Check` — a pure
predicate-plus-message factory over an injected `probe`/`fs`/`env`/`project`/`tauri` seam, never a
raw subprocess/fs call of its own:

| Module | Diagnoses | Posture |
|---|---|---|
| `rustup.ts` | rustup present; the target's required rust triple installed | fail |
| `node.ts` | a real `node` binary on PATH, distinct from bun (tauri#9939) | fail |
| `xcode.ts` | Xcode/xcodebuild present, simulators queryable (ios, macOS host only) | fail |
| `android.ts` | `ANDROID_HOME`/SDK, NDK, JDK presence (android) | fail |
| `signing.ts` | signing env-var **presence** (never values) — Apple vars for ios/macos, `signing.android.keystorePasswordEnv` for android | warn |
| `completeness.ts` | mobile `gen/` required-file-set via `project.completeness()`; fix-it is always `native clean --target <t>` | fail (not-initialized = pass) |
| `versions.ts` | `@tauri-apps/*` npm major version vs. the registry-pinned crate range | **warn only** |
| `web-script.ts` | `web.build`/`web.devCommand` scripts exist in the SAME cwd Tauri will use (`web.cwd` honored); necessary-not-sufficient, never executes the script | fail |
| `tauri-cli.ts` | CLI invokable via `tauri.version()` — the one probe routed through `tauri`, not this plugin's own `probeImpl` | fail |
| `cross-repo.ts` | worker CORS must allow `tauri://localhost`/`http://tauri.localhost` (always fires); deep-link `.well-known` pointer (fires only when `deep-link` is composed) | **warn only, always** |

A check's `appliesTo(target, global)` decides whether it participates in a given scope — a real
`Target` for per-target checks, or `"host"` for checks that run once regardless of how many
targets are configured.

## Configuration

```ts
pluginConfigs: {
  doctor: {
    probeImpl?: ProbeFn;   // test seam — default: real spawn (which/--version subprocesses)
  };
}
```

`probeImpl` is doctor's own subprocess seam for every **non-tauri** binary probe (`rustup`,
`xcodebuild`, `java`, `node`, …). The one tauri-CLI probe (`tauri-cli.ts`) goes through
`app.tauri.version()` instead — the subprocess-seam ownership boundary (`tauri` owns the
`@tauri-apps/cli` seam) stays intact.

## Design notes

- **Depends:** `[project, tauri]` (D-007) — `project` supplies `requiredFiles`/`completeness`/
  `registryRows`; `tauri` supplies the one CLI-invokability probe.
- **No `onInit`/`onStart`/`onStop`** — project owns config validation; the check registry is
  static; checks run only on `run()` calls, nothing outlives one.
- **Signing values never logged** — every signing check reads presence only (`ctx.env.has`), never
  a value (`ctx.env.get`), into any message or fix-it.
- **Domain files**: `types.ts` (`DoctorApi`/`DoctorContext`/`DoctorReport`/`CheckResult`), `api.ts`
  (check selection + parallel dispatch + emission), `report.ts` (ok computation +
  settled-rejection → internal-error mapping), `checks/` (the ten check modules + registry).
