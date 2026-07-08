# @moku-labs/native

Node-only native packager framework for Moku, built on `@moku-labs/core`. It generates a
gitignored Tauri project, codegens the permission surface (`capabilities`, `Info.plist`,
`AndroidManifest.xml`) from whichever system plugins you compose, and runs `tauri build` —
the deploy/CLI analogue for native app packaging. The permission codegen is where the
"minimal troubles" promise actually lives.

## Package Manager

Use `bun` exclusively — never npm, yarn, or pnpm.

## Scripts

- `bun run build` — Build with tsdown
- `bun run lint` — Biome check + ESLint
- `bun run lint:fix` — Auto-fix lint issues
- `bun run format` — Format with Biome
- `bun run test` — Run all tests (vitest)
- `bun run test:unit` — Unit tests only
- `bun run test:integration` — Integration tests only
- `bun run test:coverage` — Tests with coverage
- `bun run validate` — publint + are-the-types-wrong (publish readiness)

## Code Style

- **Formatter:** Biome (2-space indent, double quotes, semicolons, no trailing commas)
- **Linter:** ESLint 9 flat config + Biome (`eslint-config-biome` must be LAST)
- **TypeScript:** Strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- **Imports:** Use `import type` enforced via `@typescript-eslint/consistent-type-imports`
- **JSDoc:** Required on all source exports with descriptions, params, returns, and examples

## Architecture

Three-layer Moku model:
1. `src/config.ts` — `createCoreConfig` (Layer 1: config + events, registers `logPlugin`/`envPlugin`)
2. `src/index.ts` — `createCore` (Layer 2: framework + plugins)
3. Consumer apps use `createApp` (Layer 3)

Plugins go in `src/plugins/`. This framework's plugins are **system plugins** — each contributes
a slice of the native permission/capability surface. The packager composes whichever system
plugins the app declared and codegens `capabilities`, `Info.plist`, and `AndroidManifest.xml`
from that composition before invoking `tauri build`. The generated Tauri project is gitignored
build output, never committed.

## Family Conventions (`@moku-labs/common`)

This framework registers `logPlugin` + `envPlugin`, so every plugin `ctx` carries `ctx.log` and
`ctx.env`. Enforced by the `validate-common-usage` hook / `moku-common-validator`:

- **Logging:** use `ctx.log` — never raw `console.*`.
- **Environment:** use `ctx.env` — never raw `process.env`.
- **CLI output:** any CLI/TUI surface (the packager command included) must render through the
  branded kit `@moku-labs/common/cli` (`createBrandConsole`, `box`, `spinnerFrameAt`, styled
  `confirm`/`select`) — never ad-hoc `console.log` UI.

See the **moku-common** skill for the full rules (MC1–MC3) and examples.

## Testing

- Vitest with unit + integration projects
- Framework-level tests: `tests/unit/` and `tests/integration/` (cross-plugin scenarios, createApp validation)
- Plugin-specific tests: `src/plugins/[name]/__tests__/unit/` and `__tests__/integration/` (colocated inside each plugin)
- 90% coverage threshold
- Never put plugin-specific tests in root `tests/` — root tests are for framework-level integration only

## Moku Development Toolkit

This project uses the **moku** Claude Code plugin for development workflows.

### Commands (slash commands)

**Planning:**
- `/moku:plan [create|update|add|migrate|resume] [type] [args]` — 3-stage gated workflow to plan a
  framework, consumer app, or plugin. Output goes to `.planning/specs/` (framework/plugin) or
  `.planning/app-spec.md` (app).

**Building:**
- `/moku:build [framework|app|plugin] [spec-or-name]` — Build from specifications. Auto-detects what
  to build, resumes if partially built. Supports `/moku:build plugin #3` for individual plugins.

**Setup:**
- `/moku:init` — Initialize a new Moku project with full tooling (used to create this project).

### Skills (automatic context)

- **moku-core** — Architecture rules, factory chain, lifecycle, event system, context tiers.
- **moku-plugin** — Plugin structure, complexity tiers, file organization, wiring harness pattern.
- **moku-common** — `@moku-labs/common`: branded CLI kit, `logPlugin`/`ctx.log`, `envPlugin`/`ctx.env`.
- **moku-testing** — TDD protocol, mock context factories, integration/type-level test patterns.

### Agents (validation)

Called automatically by build commands; can also be triggered manually:

- **moku-spec-validator** — Moku Core spec compliance (three-layer separation, factory chain, lifecycle, events).
- **moku-plugin-spec-validator** — Plugin structure, correct tier, file organization, no anti-patterns.
- **moku-common-validator** — Family conventions: branded CLI (MC1), `ctx.log` (MC2), `ctx.env` (MC3).
- **moku-jsdoc-validator** — JSDoc completeness on all exports.

### Typical Workflow (framework)

1. `/moku:plan create framework "..."` — design plugins and structure (3 approval gates)
2. `/moku:build framework` — implement everything from specs
3. Validators run automatically after each plugin

## Specification

For questions about how things should be implemented, refer to the
[Moku Core specification](https://github.com/moku-labs/core/tree/main/specification).
