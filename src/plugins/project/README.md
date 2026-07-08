# project

> Complex plugin — capability registry + `.moku/tauri` generators + write-if-changed writer + mobile init-once-then-patch + clean.

Owns everything about the generated Tauri project as *files*: the capability registry
(name → packaging metadata), all generators for `.moku/tauri/` (`tauri.conf.json`,
`Cargo.toml`, `src/main.rs`/`src/lib.rs`, capability JSON, the Info.ios.plist sidecar
seam), the write-if-changed content-hash writer, the mobile completeness gate, the
Android signing patch pass, and `clean`. It never spawns subprocesses — running `tauri`
verbs is the `tauri` plugin's job; `build` orchestrates the two.

Mobile permission codegen in v1 is conf-only (D-012): store, notification,
clipboard-manager, and deep-link (custom-scheme-only, D-011) ship zero XML-patching
code, and tray is desktop-only (filtered from every mobile target-set). The only patch
domain in v1 is Android signing state.

## API

```ts
app.project.generate({ target: "macos" });
// => { written: string[], unchanged: string[], skipped: string[] }

app.project.completeness({ target: "android" });
// => { status: "not-applicable" | "not-initialized" | "incomplete" | "complete", missing?: string[] }

await app.project.patchMobile({ target: "android" });
// => { patched: string[], unchanged: string[] }

await app.project.clean({ target: "android" }); // omit target to clean the whole projectDir
// => { removed: string[] }

app.project.resolve("deep-link", { mode: "scheme", scheme: "myapp" });
// => ResolvedCapability (registry row + conf/sidecarPlist/manifest)

app.project.isKnownCapability("store"); // => true
app.project.registryRows(); // => the 5 registry rows (consumed by doctor)
app.project.requiredFiles("android"); // => required gen/android file set (consumed by doctor)
```

- `generate({ target })` — writes/refreshes every pure artifact for a target into
  `projectDir` via write-if-changed. Desktop targets get the whole tree; mobile targets
  get the shared tree + conf (the `gen/` tree itself is created by `tauri android/ios
  init`, never by this plugin).
- `completeness({ target })` — mobile `gen/<platform>` required-file-set gate. Desktop
  targets are `"not-applicable"`.
- `patchMobile({ target })` — idempotent post-init patch pass. v1 scope: Android
  signing state only (`keystore.properties` + a sentinel-delimited `build.gradle.kts`
  signing block). iOS is a documented no-op.
- `clean({ target? })` — deletes derived state. Mobile `target` → `gen/<platform>` only;
  desktop `target` → that target's bundle output; omitted → the whole `projectDir`.
  Every candidate path is validated against `projectDir` before deletion.
- `resolve(name, config?)` — typed registry lookup; throws when `name` isn't in the
  registry, or when resolving `"deep-link"` without a non-empty `scheme`.
- `isKnownCapability(name)` — runtime narrowing guard for capability names arriving
  from `config.system` as plain strings.

## Configuration

This plugin has no per-plugin config — it reads global config only (`ctx.global`):
`app`, `web`, `system`, `capabilities`, `targets`, `projectDir`, `outDir`, `signing`
(all declared in the framework's `src/config.ts`).

`onInit` validates the global config at composition time and throws `[native]`-prefixed
errors for: a missing/empty `app.name`, a non-reverse-DNS `app.identifier`, missing
`web.build`/`web.dev.command`/`web.dev.url`/`web.dist`, any `config.system` entry the
registry doesn't recognize, and a `"deep-link"` entry in `config.system` without a
matching non-empty `capabilities["deep-link"].scheme`.

### Capability registry (5 rows)

| Capability | Platforms | Confidence |
|---|---|---|
| `store` | all 5 | high |
| `notification` | all 5 | high |
| `clipboard-manager` | all 5 | high |
| `tray` | desktop only (macos/windows/linux) | low — core Tauri feature, modeled as a plugin-shaped row for registry uniformity |
| `deep-link` | all 5 (custom-scheme-only, D-011) | high |
