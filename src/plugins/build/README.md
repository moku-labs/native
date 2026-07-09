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
app.build.run({ target }): Promise<BuildResult>
app.build.runAll({ targets? }): Promise<readonly BuildResult[]>
```

```ts
type BuildResult = {
  target: Target;
  outPath: string;                    // dist-native/<target>/
  artifacts: readonly string[];       // copied installer paths
  durationMs: number;
  phases: ReadonlyArray<{ phase: NativePhase; durationMs: number }>;
};
```

- **`run`** — runs the full pipeline for ONE target. Emits `native:phase` (start/progress/done/
  error) per phase and `native:complete` on success. Rejects with whatever the first failing
  phase throws — the phase after a failing one never starts.
- **`runAll`** — runs `run` sequentially for every target in `opts.targets` (default:
  `ctx.global.targets`). Always sequential — **never** `Promise.all` — because all five targets
  share one Cargo `target/` lock; parallelism would only contend, not speed anything up. Stops at
  the first failing target (no partial-continue in v1).

### Phase semantics

| Phase | Delegate | Behavior |
|---|---|---|
| `scaffold` | `project` + `tauri` | Desktop: ensures `projectDir` exists. Mobile: `project.completeness()` gate — `"not-initialized"` runs `tauri.mobileInit()` once and re-checks; `"incomplete"` **fails fast** with a `[native]` fix-it pointing at `native doctor` / `native clean --target <t>` — a partial tree is never silently re-initialized. |
| `codegen` | `project.generate()` | Write-if-changed artifacts; mobile additionally `project.patchMobile()` (idempotent, every build — Android signing only in v1; D-012). |
| `icons` | `tauri.icon()` | v1 wires no icon-source config field anywhere in the framework, so this phase always reports `status: "done"`, `detail: "skipped"` rather than guessing a source path. |
| `compile` | `tauri.build()` | One subprocess covers compile+bundle (D-013); `compile` carries the live `onTick` progress stream (`status: "progress"`, real crate counts, never a fake percentage). |
| `bundle` | (same subprocess) | Duration is derived from the first scrubbed output line matching the compile→bundle transition; zero-duration fallback when no such line is detected. A compile failure is always attributed to `compile` — `bundle` is never emitted at all. |
| `collect` | own (`collect.ts`) | Locates artifacts via the bundle-location table, copies them to `outDir/<target>/`. **Zero matches is an error** — never a silent empty success. |

## Events

Emits the framework's **global** events (declared in `src/config.ts`) — no per-plugin events:

```ts
"native:phase": { target: Target; phase: NativePhase; status: "start" | "progress" | "done" | "error"; durationMs?: number; detail?: string };
"native:complete": { target: Target; outPath: string; artifacts: readonly string[]; durationMs: number };
```

## Configuration

No per-plugin config. Global fields consumed: `targets` (`runAll` default), `outDir` (collect
destination), `projectDir` (collect source root), `app.name`/`app.version` (informational
artifact context).

## Design notes

- **`collect.ts`'s `BUNDLE_LOCATIONS`** is a pure `Target → readonly glob[]` table, resolved
  against a per-target `bundleRoot(projectDir, target)`: desktop patterns are relative to
  `src-tauri/target/release/` (Cargo's release output); mobile patterns are relative to
  `src-tauri/` (the `gen/<platform>/` tree). Copies use `fs.cp(..., { recursive: true })` so a
  macOS `.app` bundle (a directory) and single-file installers copy through the same call.
- **State: none.** Each `run()` is a self-contained pass — results are returned, not stored.
- **No `onInit`** — config validation is owned by `project.onInit` (single owner); pipeline
  inputs are validated per-run instead.
- **Domain files**: `pipeline.ts` (phase sequencing, timing, `native:phase` emission, the mobile
  scaffold gate, the compile/bundle subprocess split), `collect.ts` (bundle-location table +
  `bundleRoot()` + `collectArtifacts()` — pure locate/copy), `api.ts` (`run`/`runAll` composition).
