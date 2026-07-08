import { describe, expect, it } from "vitest";
import { createTauriState } from "../../state";

describe("createTauriState", () => {
  it("returns state with no live dev session", () => {
    const state = createTauriState();
    expect(state).toEqual({ dev: undefined });
  });

  it("returns a fresh object on every call", () => {
    const first = createTauriState();
    const second = createTauriState();
    expect(first).not.toBe(second);
  });
});
