# build

> Standard plugin — sequential per-target pipeline emitting global `native:phase`/`native:complete`; owns the collect phase (bundle-location table → `dist-native/<target>/`).

The per-target packaging orchestrator. Runs `scaffold → codegen → icons → compile → bundle →
collect` for one target, delegating `scaffold`/`codegen` to `project` and `icons`/`compile`/
`bundle` to `tauri` (`ctx.require`, D-007) — `build` never spawns a process itself (D-013). It
owns exactly one phase directly: `collect`, a pure `Target → glob patterns` table that locates
the finished installer(s) in Tauri's internal output layout and copies them to a stable
`dist-native/<target>/` delivery location.

## API

```ts
app.build.prepare({ target }): Promise<void>
app.build.run({ target, simulator?, aab? }): Promise<BuildResult>
app.build.runAll({ targets?, simulator?, aab? }): Promise<readonly BuildResult[]>
```

```ts
type BuildResult = {
  target: Target;
  outPath: string;                    // dist-native/<target>/
  artifacts: readonly string[];       // copied installer paths
  durationMs: number;
  phases: readonly PhaseTiming[];     // always all six phases, in order
};
```

- **`prepare`** — runs `scaffold → codegen → icons` and stops: everything that makes the
  generated project buildable, without invoking the build verb. `cli.dev` calls it first, so
  a dev session never compiles a stale or half-generated tree.
- **`run`** — runs the full pipeline for ONE target. Emits `native:phase` (start/progress/done/
  error) per phase and `native:complete` on success. Rejects with whatever the first failing
  phase throws — the phase after a failing one never starts. `simulator` (iOS) and `aab`
  (Android) are forwarded to `tauri.build()`; `--export-method` comes from
  `config.signing.apple.exportMethod`.
- **`runAll`** — runs `run` sequentially for every target in `opts.targets` (default:
  `ctx.global.targets`). Always sequential — **never** `Promise.all` — because all five targets
  share one Cargo `target/` lock; parallelism would only contend, not speed anything up. Stops at
  the first failing target (no partial-continue in v1).

### Phase semantics

| Phase | Delegate | Behavior |
|---|---|---|
| `scaffold` | own | Ensures `projectDir` exists. Nothing else: the mobile `gen/` tree is initialized in `codegen`, because `tauri ios\|android init --ci` refuses to run before `tauri.conf.json` exists. |
| `codegen` | `project` + `tauri` | `project.generate()` first. Mobile then: `tauri.mobileInit()` when `project.getCompleteness()` is `"not-initialized"`, the completeness gate (an `"incomplete"` tree **fails fast** with a `[native]` fix-it pointing at `native doctor` / `native clean --target <t>` — a partial tree is never silently re-initialized), then the idempotent `project.patchMobile({ target, runner: tauri.getRunner() })` pass — Tauri's generated build phase calls a bare `node tauri` command that does not exist. |
| `icons` | `project` + `tauri` | Source from `project.ensureIconSource()` (`config.app.icon`, or a generated 1024×1024 placeholder), then `tauri.icon({ source })`. Regeneration is skipped **only** when `src-tauri/icons/icon.png` is newer than the source AND this pass did not run `mobileInit` (a fresh `gen/` tree ships Tauri's default icons). Detail: `"up to date"`, `"generated"` or `"placeholder"`. |
| `compile` | `tauri.build()` | One subprocess covers compile+bundle (D-013); `compile` carries the live `onTick` progress stream (`status: "progress"`, real crate counts, never a fake percentage). |
| `bundle` | (same subprocess) | The transition is **live**: the first output line matching the bundling pattern closes `compile` and opens `bundle` while the subprocess is still running. No transition line: `compile` closes at exit and `bundle` is reported with a zero duration. A failure is attributed to whichever phase is open, so a bundling/signing error reads as `bundle`, not `compile`. |
| `collect` | own (`collect.ts`) | Locates artifacts via the bundle-location table, copies them to `outDir/<target>/`. The artifact flavour picks ONE pattern set, never two: iOS collects the `*-sim/*.app` with `simulator` and the `.ipa` otherwise; Android collects `**/*.aab` with `aab` and `**/*.apk` otherwise — a stale artifact from the other flavour can never ship. **Zero matches is an error** — never a silent empty success. |

## Events

Emits the framework's **global** events (declared in `src/config.ts`) — no per-plugin events:

```ts
"native:phase": { target: Target; phase: NativePhase; status: "start" | "progress" | "done" | "error"; durationMs?: number; detail?: string };
"native:complete": { target: Target; outPath: string; artifacts: readonly string[]; durationMs: number };
```

## Configuration

No per-plugin config. Global fields consumed: `targets` (`runAll` default), `outDir` (collect
destination), `projectDir` (collect source root), `app.icon` (icons-phase detail),
`signing.apple.exportMethod` (iOS device archives), `app.name`/`app.version` (informational
artifact context).

## Design notes

- **`collect.ts`'s `BUNDLE_LOCATIONS`** is a pure `Target → readonly glob[]` table, resolved
  against a per-target `bundleRoot(projectDir, target)`: desktop patterns are relative to
  `src-tauri/target/release/` (Cargo's release output); mobile patterns are relative to
  `src-tauri/` (the `gen/<platform>/` tree). Copies use `fs.cp(..., { recursive: true })` so a
  macOS `.app` bundle (a directory) and single-file installers copy through the same call.
- **Simulator vs device** — `collectArtifacts(..., { simulator: true })` matches
  `gen/apple/build/*-sim/*.app` and **never** a device `.ipa`; a plain iOS pass matches
  `gen/apple/build/**/*.ipa` and never the simulator bundle. A simulator build is unsigned and
  produces a `.app` DIRECTORY whose name carries the product's display name, spaces included —
  hence the recursive copy.
- **Dependencies resolved once** — `createBuildApi` resolves `project` and `tauri` at
  composition time and threads them through every phase as `deps`; the pipeline never calls
  `ctx.require` per phase.
- **State: none.** Each `run()` is a self-contained pass — results are returned, not stored.
- **No `onInit`** — config validation is owned by `project.onInit` (single owner); pipeline
  inputs are validated per-run instead.
- **Domain files**: `pipeline.ts` (phase sequencing, timing, `native:phase` emission, the mobile
  init/completeness gate, the icons freshness rule, the live compile→bundle split), `collect.ts`
  (bundle-location table + `bundleRoot()` + `bundlePatterns()` + `collectArtifacts()` — pure
  locate/copy), `api.ts` (`prepare`/`run`/`runAll` composition).
