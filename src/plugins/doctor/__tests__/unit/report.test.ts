import { describe, expect, it } from "vitest";
import { assembleReport, toCheckResult } from "../../report";
import type { CheckResult } from "../../types";

describe("assembleReport", () => {
  it("is ok when every check passes", () => {
    const checks: CheckResult[] = [
      { id: "a", target: "host", status: "pass", message: "ok" },
      { id: "b", target: "host", status: "pass", message: "ok" }
    ];

    expect(assembleReport(checks)).toEqual({ ok: true, checks });
  });

  it("stays ok when a check warns", () => {
    const checks: CheckResult[] = [
      { id: "a", target: "host", status: "pass", message: "ok" },
      { id: "b", target: "host", status: "warn", message: "meh" }
    ];

    expect(assembleReport(checks).ok).toBe(true);
  });

  it("flips to not-ok when any check fails", () => {
    const checks: CheckResult[] = [
      { id: "a", target: "host", status: "pass", message: "ok" },
      { id: "b", target: "host", status: "warn", message: "meh" },
      { id: "c", target: "ios", status: "fail", message: "bad" }
    ];

    expect(assembleReport(checks).ok).toBe(false);
  });

  it("is ok for an empty check list (vacuous truth)", () => {
    expect(assembleReport([])).toEqual({ ok: true, checks: [] });
  });
});

describe("toCheckResult", () => {
  it("passes a fulfilled outcome through unchanged", () => {
    const value: CheckResult = { id: "a", target: "host", status: "pass", message: "ok" };
    const outcome: PromiseSettledResult<CheckResult> = { status: "fulfilled", value };

    expect(toCheckResult(outcome, { id: "a", target: "host" })).toBe(value);
  });

  it("maps a rejection into a synthetic internal-error fail result", () => {
    const outcome: PromiseSettledResult<CheckResult> = {
      status: "rejected",
      reason: new Error("boom")
    };

    const result = toCheckResult(outcome, { id: "rustup-targets", target: "ios" });

    expect(result.status).toBe("fail");
    expect(result.id).toBe("rustup-targets");
    expect(result.target).toBe("ios");
    expect(result.message).toContain("boom");
    expect(result.message.startsWith("[native]")).toBe(true);
  });

  it("stringifies a non-Error rejection reason", () => {
    const outcome: PromiseSettledResult<CheckResult> = { status: "rejected", reason: "nope" };

    const result = toCheckResult(outcome, { id: "x", target: "host" });

    expect(result.message).toContain("nope");
  });
});
