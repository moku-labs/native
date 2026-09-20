# cli

> Standard plugin — typed verb surface (`build`/`dev`/`doctor`/`clean`), branded rendering (MC1), live progress via hooks.

The consumer-facing verb layer. Verbs are **typed API methods, not an argv CLI** — consumers
write thin per-verb scripts (mirroring `@moku-labs/web`'s cli precedent), and every line of
output flows through the branded kit `@moku-labs/common/cli` (MC1: `createBrandConsole`, `box`,
`spinnerFrameAt`, styled confirm) — never raw `console.*` (test-enforced via spy). Live progress
renders through this plugin's hooks on the global `native:phase`/`native:complete` events and
`doctor`'s `doctor:check` (merged via the depends edge, spec/07 §5).

## API

| Verb | Signature | What it does |
|---|---|---|
| `build` | `build(opts?: { target?: Target; all?: boolean; simulator?: boolean; aab?: boolean }): Promise<void>` | One target (default: the host target) or every configured target with `{ all: true }`. |
| `dev` | `dev(opts?: { target?: Target }): Promise<void>` | Prepares the project, then runs the dev loop until it exits. |
| `doctor` | `doctor(opts?: { target?: Target }): Promise<boolean>` | Diagnoses and returns `report.ok`. |
| `clean` | `clean(opts?: { target?: Target }): Promise<void>` | Deletes derived state (confirm-gated without a `target`). |

- **`build`** — the host-target default comes from the framework's own `hostTargets`
  (darwin→macos, win32→windows, linux→linux; mobile targets are never inferred; cli
  keeps no second table). `simulator` (iOS: build for the host's simulator arch) and `aab`
  (Android: emit a store bundle instead of an apk) pass straight through to
  `build.run`/`build.runAll`. Progress renders live via the `native:phase`/`native:complete`
  hooks. On failure the classified `TauriError`'s scrubbed `stderrTail` prints above the
  `[native]` error line, then the error rethrows unchanged. One pure decision,
  `tailLineBound(process.stdout.columns)`, settles both how wide a tail line may be and
  whether it is framed at all:

  | stdout | tail | why |
  |---|---|---|
  | a terminal, 120 columns | a branded `box`, each line cut to 114 (`terminalWidth()` clamps 60–160, minus the box chrome, floor 40) | a single Rust/xcodebuild diagnostic runs thousands of characters and would wrap the box into noise |
  | no columns (CI, `native build > build.log`, any pipe) | no box — every line printed plainly and whole, in order | nothing wraps against a file, truncating deletes the only copy of the toolchain's own error text, and a box pads every line to the widest one, so one 5000-character diagnostic would bloat the whole log |
- **`dev`** — awaits `build.prepare({ target })` first, so `tauri dev` never meets a
  half-generated tree; the target defaults to the host target and a host with no
  desktop target throws the `[native]` fix-it error. Then it runs the dev loop
  (`tauri dev` / `tauri ios|android dev`) and awaits the handle's `ready` (dev output streams
  through the scrubbed `onOutput` render seam, D-014) then `exited`. It **never stores the
  handle and never calls `stop()`** — teardown is owned entirely by the tauri seam's control
  flow (D-002). Rejects only on a numeric non-zero exit code; a signal-terminated exit
  (`code: null` — e.g. Ctrl-C → tauri's SIGINT group-kill) is the *normal* way a dev session
  stops and resolves cleanly.
- **`doctor`** — delegates to `doctor.run`. Each check's row (with its fix-it) prints
  exactly ONCE, live from the `doctor:check` hook as the check settles; the summary adds only
  the `pass N · warn N · fail N` counts and the overall verdict. Returns `report.ok` —
  the consumer script sets `process.exitCode`.
- **`clean`** — thin delegate to `project.clean` (D-006: project owns the destructive
  filesystem knowledge). Without a `target`, the full-`projectDir` wipe is gated behind a
  styled confirm; declining resolves without deleting anything.

Consumer scripts stay thin (one verb each):

```ts
// scripts/native-build.ts
import { native } from "../src/native";
await native.start();
await native.cli.build({ target: "macos" });
await native.stop();
```

## Events

None declared — hooks only. Listens to `native:phase`, `native:complete` (global, declared in
`src/config.ts` — D-003) and `doctor:check` (per-plugin, hookable via the `doctorPlugin`
depends edge).

## Configuration

```ts
type Config = {
  renderImpl?: RenderFn | undefined;   // (line: string) => void — test seam; default: branded console
  confirmImpl?: ConfirmFn | undefined; // (question: string) => Promise<boolean> — test seam; default: styled confirm
};
```

`renderImpl` resolves once in `createState` (the console lives on `ctx.state.ui`), `confirmImpl`
at the first verb call; `undefined` (the default) binds the real branded kit. Global fields
consumed: `targets` (verb default fallback), `app.name` (complete-box panel header),
`projectDir` (clean confirm message).

## Log sink

Composing this plugin also takes over the framework's log output: `onInit` clears the default
sink and installs a branded one (`createLogSink`, threshold `info`). Structured `ctx.log`
records render as branded lines — the event id, then its payload as dim JSON — instead of raw
`{ level, event, data, ts }` objects printed between the branded lines. `debug` records (a raw
`tauri info` dump, for one) stay in the in-memory trace and never reach the terminal.

The sink renders through `ctx.state.ui`, the same console every verb and hook writes to, so an
injected `renderImpl` captures log lines along with everything else and a composed app still
makes zero raw `console.*` calls.

## Design notes

- **`state.ts`** builds the ONE branded console (`ctx.state.ui`) from the configured render
  seam. `api.ts` and `handlers.ts` both render through it, so a verb and its live
  progress hooks always write to the same sink.
- **`render.ts`** composes the branded kit behind the seams: `createRenderConsole` binds
  `renderImpl` and the `terminalWidth()` column count into `createBrandConsole`,
  `createLogSink` turns a console into the log sink `onInit` installs; pure
  formatters build the phase spinner lines
  (`spinnerFrameAt`, real progress ticks only — never a fake percentage), the `native:complete`
  `box` panel (target, artifact paths, total duration), the live doctor rows + fix-its, the
  counts-only summary, and the failed-build stderr-tail box. All failure text uses the
  `[native]` actionable-suggestion style (spec/11 Part 3).
- **`handlers.ts`** keeps the running phase's `startedAt` in `ctx.state.progress` — not in
  handler-closure variables — so hooks and verb calls share it without module-level leakage
  (spec/11 §2.4). `undefined` marks "no active phase" (D-014).
- **Dependencies**: all four upstream plugins via `ctx.require` (D-007) — `project` (clean),
  `tauri` (dev), `build` (run/runAll), `doctor` (run + the `doctor:check` hook edge).
- **Lifecycle** — `onInit` installs the branded log sink and nothing else (project owns config
  validation); no `onStart` (verbs are explicit calls), no `onStop` (nothing held — the dev
  handle never lives here, D-002).
