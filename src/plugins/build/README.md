# build

> Standard plugin — sequential per-target pipeline emitting global `native:phase`/`native:complete`; owns the collect phase (`project.getBundleLayout` → globs → `dist-native/<target>/`, or `dist-native/<target>-debug/` for a debug build).

The per-target packaging orchestrator. Runs `scaffold → codegen → icons → compile → bundle →
collect` for one target, delegating `scaffold`/`codegen` to `project` and `icons`/`compile`/
`bundle` to `tauri` (`ctx.require`, D-007) — `build` never spawns a process itself (D-013). It
owns exactly one phase directly: `collect`, which turns the layout it gets from
`project.getBundleLayout({ target })` into globs, locates the finished installer(s) in Tauri's
internal output layout, and copies them to a stable `dist-native/<target>/` delivery location.

## API

```ts
app.build.prepare({ target, debug? }): Promise<void>
app.build.run({ target, simulator?, aab?, debug?, dev? }): Promise<BuildResult>
app.build.runAll({ targets?, simulator?, aab?, debug?, dev? }): Promise<readonly BuildResult[]>
```

```ts
type BuildResult = {
  target: Target;
  outPath: string;                    // dist-native/<target>/ — dist-native/<target>-debug/ in debug
  artifacts: readonly string[];       // copied installer paths
  durationMs: number;
  phases: readonly PhaseTiming[];     // always all six phases, in order
  profile: BuildProfile;              // "store" | "debug" | "dev" — the same value native:complete carries
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
- **`debug`** — builds the debug profile instead of the store one: a release build with debug
  marks (Decision D1) that installs beside the store app. **Android and iOS only for now**
  (Decision D2, widened to iOS by F133): `debug` on any other target throws
  `[native] --debug builds Android and iOS only for now (asked for <target>).` before scaffold,
  so no phase event is emitted. `runAll` with `debug` checks every target up front and refuses
  the whole run if one is neither — nothing is half-built. `prepare` takes `debug` too (store
  when omitted) and applies the same guard.
- **`dev`** — builds the dev profile: the store build a tester installs, on any target. `run`
  and `runAll` take it, `prepare` does not. It differs from store in three things: a page with
  the editor agent is not refused, `MOKU_NATIVE_PROFILE` reads `dev`, and `project` leaves
  `removeUnusedCommands` out. Signing, `.aab`, `exportMethod` and the delivery to
  `<outDir>/<target>` are the store build's; the app config names the test app.
- **`profileOf`** — the one place a flavour becomes a profile: `debug` → `"debug"`, `dev` →
  `"dev"`, otherwise `"store"`. `debug` and `dev` together throw
  `[native] debug and dev cannot be combined.` before scaffold, and `runAll` checks it before
  the first target and before the target guard, so the error names the real problem.
- **`runAll`** — runs `run` sequentially for every target in `opts.targets` (default:
  `ctx.global.targets`). Always sequential — **never** `Promise.all` — because all five targets
  share one Cargo `target/` lock; parallelism would only contend, not speed anything up. Stops at
  the first failing target (no partial-continue in v1).

### Phase semantics

| Phase | Delegate | Behavior |
|---|---|---|
| `scaffold` | own | Ensures `projectDir` exists. Nothing else: the mobile `gen/` tree is initialized in `codegen`, because `tauri ios\|android init --ci` refuses to run before `tauri.conf.json` exists. |
| `codegen` | `project` + `tauri` | `project.generate({ target, profile })` first (the debug profile generates the shell crate on android). Mobile then: `tauri.mobileInit()` when `project.getCompleteness()` is `"not-initialized"`, the completeness gate (an `"incomplete"` tree **fails fast** with a `[native]` fix-it pointing at `native doctor` / `native clean --target <t>` — a partial tree is never silently re-initialized), then the idempotent `project.patchMobile({ target, runner: tauri.getRunner(), profile })` pass (debug on android: `.debug` id suffix, `(debug)` name, debug keystore, cleartext; store and dev: all reverted) — Tauri's generated build phase calls a bare `node tauri` command that does not exist. |
| `icons` | `project` + `tauri` | Source from `project.ensureIconSource()` (`config.app.icon`, or a generated 1024×1024 placeholder), then `tauri.icon({ source })`. Regeneration is skipped **only** when `src-tauri/icons/icon.png` exists, the stamp beside it (`src-tauri/icons/.source` — absolute source path, size, mtime) still describes the current source, AND this pass did not run `mobileInit` (a fresh `gen/` tree ships Tauri's default icons). The stamp is what makes pointing `app.icon` at an OLDER file regenerate, which an mtime comparison alone misses. Then, on android, `project.patchMobileIcons({ target })` re-applies the adaptive icon inset — on EVERY build, also when the set was up to date, because `tauri icon` rewrites the launcher files the inset lives in. Detail: `"up to date"`, `"generated"` or `"placeholder"`. |
| `compile` | `project` + `tauri.build()` | iOS first calls `project.clearMobileBuildOutput({ target })` — `tauri ios build` renames its fresh `.app` into the archive the previous build left in `gen/apple/build` and fails the SECOND build of a tree with `Directory not empty`. It runs inside the compile phase, so a refusal from that guarded remove is reported as a compile error, and `tauri.build` never starts. Something removed → one `status: "progress"` event with detail `"cleared previous build output"`; nothing removed → silence. Desktop and Android skip it entirely. Then one subprocess covers compile+bundle (D-013), spawned with `env: { MOKU_NATIVE_PROFILE: profile }` so the engine's web build — which tauri runs inside `tauri build` — can tell the profiles apart; `compile` carries the live `onTick` progress stream (`status: "progress"`, real crate counts, never a fake percentage). |
| `bundle` | (same subprocess) | The transition is **live**: the first output line matching the bundling pattern closes `compile` and opens `bundle` while the subprocess is still running. No transition line: `compile` closes at exit and `bundle` is reported with a zero duration. A failure is attributed to whichever phase is open, so a bundling/signing error reads as `bundle`, not `compile`. **End of compile/bundle, before collect** (still inside the open phase): on android `project.checkShellLinked({ target, profile })` (the project plugin decides whether the profile composes the shell; a tree initialised before the shell existed fails here), then the page check `project.detectPageAgent()` — a **store** build whose page carries the editor agent fails with `[native] store build refused: the page carries the editor agent (<dist>/<file>).` / `Build with debug: true.` and nothing is collected, so no store artifact with the agent reaches `outDir`. A debug or dev build with the agent and any clean page pass. The refusal comes **after the full compile**, not before it: tauri runs the web build inside `tauri build`, so the page that will ship only exists once the subprocess has finished. |
| `collect` | own (`collect.ts`) | Locates artifacts via the layout from `project.getBundleLayout({ target })`, copies them to `outDir/<target>/` — `outDir/<target>-debug/` for a debug build, so the debug installer never overwrites the store one (same release patterns: the debug profile is a release build type). The artifact flavour picks ONE pattern set, never two: iOS collects the `*-sim/*.app` plus `x86_64/*.app` with `simulator` (both directory names a simulator slice can land under) and the `.ipa` otherwise; Android collects `bundle/**/*elease*/*.aab` with `aab` and `apk/**/*elease*/*.apk` otherwise (the release flavour is pinned in the glob: Gradle writes every build type side by side, so an unpinned `outputs/**` pattern ships a debug installer) — a stale artifact from the other flavour can never ship. Each destination is REMOVED before the copy (`fs.cp` merges into an existing `.app`, leaving stale files inside the bundle), after asserting — on REAL paths, via `project.resolveDerivedPath` — that it is strictly inside `<outDir>/<target>` and that directory strictly inside `outDir`; a lexical comparison reads `<outDir>/<target>` as contained even when it is a symlink into an unrelated tree, and the next statement deletes that tree. Matches are deduplicated by destination name, keeping the NEWEST by mtime: a mobile build leaves one directory per arch and never prunes the ones it did not rebuild, so "whichever the glob yielded last" could ship yesterday's binary. **Zero matches is an error** — never a silent empty success. |

## Events

Emits the framework's **global** events (declared in `src/config.ts`) — no per-plugin events:

```ts
"native:phase": { target: Target; phase: NativePhase; status: "start" | "progress" | "done" | "error"; durationMs?: number; detail?: string };
"native:complete": { target: Target; outPath: string; artifacts: readonly string[]; durationMs: number; profile: BuildProfile };
```

## Configuration

No per-plugin config. Global fields consumed: `targets` (`runAll` default), `outDir` (collect
destination), `projectDir` (collect source root), `app.icon` (icons-phase detail),
`signing.apple.exportMethod` (iOS device archives), `app.name`/`app.version` (informational
artifact context).

## Design notes

- **No path rule of its own either.** The collect guard removes a destination before copying
  onto it, so it must answer exactly what the clean guard answers. The comparison form comes
  from the same owner, through deps — `project.resolveDerivedPath` — never from a second,
  lexical copy in this plugin.
- **No bundle table of its own.** Where a target's output lands is the `project` plugin's
  knowledge (`project/layout.ts`), and it arrives here through deps as a `BundleLayout`:
  `bundleRoot(projectDir, layout)` resolves the root — desktop under `src-tauri/target/release/`
  (Cargo's release output), mobile under `src-tauri/` (the `gen/<platform>/` tree) — and
  `bundlePatterns(layout, target, opts)` turns the layout's format directories into globs.
  Copies use `fs.cp(..., { recursive: true })` so a macOS `.app` bundle (a directory) and
  single-file installers copy through the same call, over a destination removed first and
  proven to sit inside the delivery directory (`artifactDestination()`).
- **Simulator vs device** — `collectArtifacts(..., { simulator: true })` matches
  `gen/apple/build/*-sim/*.app` **and** `gen/apple/build/x86_64/*.app` — Tauri names the Intel
  simulator slice `x86_64`, with no `-sim` suffix, so the suffixed glob alone finds nothing on an
  x64 host — and **never** a device `.ipa`; a plain iOS pass matches
  `gen/apple/build/**/*.ipa` and never the simulator bundle — one `.ipa` name per delivery,
  however many stale arch directories still hold a copy. A simulator build is unsigned and
  produces a `.app` DIRECTORY whose name carries the product's display name, spaces included —
  hence the recursive copy.
- **Dependencies resolved once** — `createBuildApi` resolves `project` and `tauri` at
  composition time and threads them through every phase as `deps`; the pipeline never calls
  `ctx.require` per phase.
- **Profile threading** — the profile is derived once per run (`profileOf`) and handed to every
  delegate that needs it: `generate`, `patchMobile`, `checkShellLinked`, the tauri CLI's
  environment, collect (delivery directory) and `native:complete` (so the CLI marks a debug
  delivery). `BuildDeps.project` also picks `patchMobileIcons`, `detectPageAgent` and
  `checkShellLinked`.
- **State: none.** Each `run()` is a self-contained pass — results are returned, not stored.
- **No `onInit`** — config validation is owned by `project.onInit` (single owner); pipeline
  inputs are validated per-run instead.
- **Domain files**: `pipeline.ts` (phase sequencing, timing, `native:phase` emission, the mobile
  init/completeness gate, the icons freshness rule, the live compile→bundle split), `collect.ts`
  (`bundleRoot()` + `bundlePatterns()` + `collectArtifacts()` — pure locate/copy over a
  `BundleLayout` it is handed), `api.ts` (`prepare`/`run`/`runAll` composition), `types.ts`
  (`BuildDeps` — the exact `project`/`tauri` slices the pipeline calls).
