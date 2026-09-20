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
  hooks. On failure the classified `TauriError`'s scrubbed `stderrTail` is framed in a
  branded `box` above the `[native]` error line (tail lines wider than 160 characters are
  truncated with an ellipsis, so one huge diagnostic cannot wrap the box into noise), then the
  error rethrows unchanged.
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

## Design notes

- **`state.ts`** builds the ONE branded console (`ctx.state.ui`) from the configured render
  seam. `api.ts` and `handlers.ts` both render through it, so a verb and its live
  progress hooks always write to the same sink.
- **`render.ts`** composes the branded kit behind the seams: `createRenderConsole` binds
  `renderImpl` into `createBrandConsole`; pure formatters build the phase spinner lines
  (`spinnerFrameAt`, real progress ticks only — never a fake percentage), the `native:complete`
  `box` panel (target, artifact paths, total duration), the live doctor rows + fix-its, the
  counts-only summary, and the failed-build stderr-tail box. All failure text uses the
  `[native]` actionable-suggestion style (spec/11 Part 3).
- **`handlers.ts`** keeps the running phase's `startedAt` in `ctx.state.progress` — not in
  handler-closure variables — so hooks and verb calls share it without module-level leakage
  (spec/11 §2.4). `undefined` marks "no active phase" (D-014).
- **Dependencies**: all four upstream plugins via `ctx.require` (D-007) — `project` (clean),
  `tauri` (dev), `build` (run/runAll), `doctor` (run + the `doctor:check` hook edge).
- **No lifecycle** — no `onInit` (project owns config validation), no `onStart` (verbs are
  explicit calls), no `onStop` (nothing held — the dev handle never lives here, D-002).
