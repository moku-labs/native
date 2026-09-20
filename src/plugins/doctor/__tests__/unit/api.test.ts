import type { LogApi } from "@moku-labs/common";
import { describe, expect, it, vi } from "vitest";
import { createDoctorApi } from "../../api";
import type { CheckResult, DoctorContext, ProbeFn } from "../../types";
import { baseGlobalConfig, createEnv } from "./checks/fixtures";
import { createMockRequire } from "./mock-require";

/** A probe that never settles — the only way to make a check outrun `probeTimeoutMs`. */
const probeNeverSettles: ProbeFn = () =>
  new Promise<{ code: number; stdout: string }>(() => undefined);

/**
 * Builds a probe that resolves after `delayMs`, answering rustup with an installed
 * macOS triple so the rustup check passes once it finally settles.
 *
 * @param delayMs - How long the probe stays pending.
 * @returns The delayed probe.
 */
function probeAfter(delayMs: number): ProbeFn {
  return () =>
    new Promise(resolve => {
      setTimeout(() => resolve({ code: 0, stdout: "aarch64-apple-darwin" }), delayMs);
    });
}

/** A no-op `LogApi` stand-in — doctor only ever calls `info`. */
function createLog(): LogApi {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as LogApi;
}

/** The two plugin APIs doctor's `require` hands back, narrowed to what checks read. */
const projectApi = {
  requiredFiles: vi.fn(() => []),
  completeness: vi.fn(() => ({ status: "not-applicable" as const })),
  registryRows: vi.fn(() => [])
};
const tauriApi = { version: vi.fn(async () => ({ cliVersion: "2.0.0" })) };

/**
 * Builds a mock `DoctorContext` plus the emission sink `doctor:check` lands in.
 *
 * @param opts - Per-test seam overrides.
 * @param opts.probeImpl - The injected probe seam.
 * @param opts.probeTimeoutMs - The per-check timeout budget (default 10_000).
 * @returns The mock context and the ordered emission sink.
 */
function createContext(opts: { probeImpl: ProbeFn; probeTimeoutMs?: number }): {
  ctx: DoctorContext;
  emitted: CheckResult[];
} {
  const emitted: CheckResult[] = [];
  const ctx: DoctorContext = {
    global: baseGlobalConfig,
    config: { probeImpl: opts.probeImpl, probeTimeoutMs: opts.probeTimeoutMs ?? 10_000 },
    log: createLog(),
    env: createEnv(),
    // doctor has no state of its own — core hands a stateless plugin the empty object.
    state: {},
    emit: (_name, payload) => {
      emitted.push(payload);
    },
    require: createMockRequire({ project: projectApi, tauri: tauriApi })
  };
  return { ctx, emitted };
}

describe("createDoctorApi — per-check emission", () => {
  it("emits doctor:check as each check settles, not in one batch after all of them", async () => {
    // macos scope schedules [rustup-targets, signing-macos] in registry order; only
    // rustup touches the (slow) probe seam, so signing settles — and emits — first.
    const { ctx, emitted } = createContext({ probeImpl: probeAfter(20) });

    const report = await createDoctorApi(ctx).run({ target: "macos" });

    expect(emitted.map(result => result.id)).toEqual(["signing-macos", "rustup-targets"]);
    expect(report.checks.map(result => result.id)).toEqual(["rustup-targets", "signing-macos"]);
  });

  it("emits exactly one event per reported check", async () => {
    const { ctx, emitted } = createContext({ probeImpl: probeAfter(0) });

    const report = await createDoctorApi(ctx).run({ target: "macos" });

    expect(emitted).toHaveLength(report.checks.length);
    expect(emitted.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
      report.checks.toSorted((a, b) => a.id.localeCompare(b.id))
    );
  });
});

describe("createDoctorApi — probeTimeoutMs", () => {
  it("yields a warn result for a check that outruns the timeout", async () => {
    const { ctx } = createContext({ probeImpl: probeNeverSettles, probeTimeoutMs: 5 });

    const report = await createDoctorApi(ctx).run({ target: "macos" });

    const rustup = report.checks.find(result => result.id === "rustup-targets");
    expect(rustup?.status).toBe("warn");
    expect(rustup?.message).toBe('[native] doctor check "rustup-targets" timed out.');
    expect(rustup?.fixIt).toContain("probeTimeoutMs");
    expect(rustup?.target).toBe("macos");
  });

  it("does not flip report.ok — a timeout is a warn, never a fail", async () => {
    const { ctx, emitted } = createContext({ probeImpl: probeNeverSettles, probeTimeoutMs: 5 });

    const report = await createDoctorApi(ctx).run({ target: "macos" });

    expect(report.ok).toBe(true);
    expect(emitted).toHaveLength(report.checks.length);
  });

  it("leaves a check that settles inside the budget untouched", async () => {
    const { ctx } = createContext({ probeImpl: probeAfter(0), probeTimeoutMs: 1000 });

    const report = await createDoctorApi(ctx).run({ target: "macos" });

    const rustup = report.checks.find(result => result.id === "rustup-targets");
    expect(rustup?.status).toBe("pass");
  });
});
