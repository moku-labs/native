# cli

> Standard plugin — typed verb surface (`build`/`dev`/`doctor`/`clean`), branded rendering (MC1), live progress via hooks.

The consumer-facing verb layer. Verbs are **typed API methods, not an argv CLI** — consumers
write thin per-verb scripts (mirroring `@moku-labs/web`'s cli precedent), and every line of
output flows through the branded kit `@moku-labs/common/cli` (MC1: `createBrandConsole`, `box`,
`spinnerFrameAt`, styled confirm) — never raw `console.*` (test-enforced via spy). Live progress
renders through this plugin's hooks on the global `native:phase`/`native:complete` events and
`doctor`'s `doctor:check` (merged via the depends edge, spec/07 §5).

## API

```ts
app.cli.build(opts?: { target?: Target; all?: boolean }): Promise<void>
app.cli.dev(opts?: { target?: Target }): Promise<void>
app.cli.doctor(opts?: { target?: Target }): Promise<boolean>
app.cli.clean(opts?: { target?: Target }): Promise<void>
```

- **`build`** — one target (default: the host target — darwin→macos, win32→windows,
  linux→linux; mobile targets are never inferred) or every configured target with
  `{ all: true }` (which ignores `target`). Delegates to `build.run`/`build.runAll`; progress
  renders live via the `native:phase`/`native:complete` hooks.
- **`dev`** — runs the dev loop (`tauri dev` / `tauri ios|android dev`). Awaits the handle's
  `ready` (dev output streams through the scrubbed `onOutput` render seam, D-014) then
  `exited`. It **never stores the handle and never calls `stop()`** — teardown is owned
  entirely by the tauri seam's control flow (D-002). Rejects only on a numeric non-zero exit
  code; a signal-terminated exit (`code: null` — e.g. Ctrl-C → tauri's SIGINT group-kill) is
  the *normal* way a dev session stops and resolves cleanly.
- **`doctor`** — delegates to `doctor.run`, renders live pass/warn/fail rows per `doctor:check`
  plus the final summary table with fix-its, and returns `report.ok` — the consumer script sets
  `process.exitCode`.
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

Both seams resolve lazily at first verb call; `undefined` (the default) binds the real branded
kit. Global fields consumed: `targets` (verb default fallback), `app.name` (complete-box panel
header), `projectDir` (clean confirm message).

## Design notes

- **`render.ts`** composes the branded kit behind the seams: `createRenderConsole` binds
  `renderImpl` into `createBrandConsole`; pure formatters build the phase spinner lines
  (`spinnerFrameAt`, real progress ticks only — never a fake percentage), the `native:complete`
  `box` panel (target, artifact paths, total duration), and the doctor rows/summary + fix-its.
  All failure text uses the `[native]` actionable-suggestion style (spec/11 Part 3).
- **`handlers.ts`** keeps live-render bookkeeping (`phase`/`startedAt`/`ticks`) in `ctx.state`
  — not handler-closure variables — so hooks and verb calls share it without module-level
  leakage (spec/11 §2.4). `undefined` marks "no active phase" (D-014).
- **Dependencies**: all four upstream plugins via `ctx.require` (D-007) — `project` (clean),
  `tauri` (dev), `build` (run/runAll), `doctor` (run + the `doctor:check` hook edge).
- **No lifecycle** — no `onInit` (project owns config validation), no `onStart` (verbs are
  explicit calls), no `onStop` (nothing held — the dev handle never lives here, D-002).
