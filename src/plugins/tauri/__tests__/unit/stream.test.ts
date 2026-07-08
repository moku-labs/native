import { describe, expect, it } from "vitest";
import { parseCompileTick, splitLines } from "../../stream";

describe("splitLines", () => {
  it("splits complete lines and carries over a trailing partial line", () => {
    const { lines, buffer } = splitLines("", "Compiling foo v1.0.0\nCompi");
    expect(lines).toEqual(["Compiling foo v1.0.0"]);
    expect(buffer).toBe("Compi");
  });

  it("prepends the carried buffer to the next chunk", () => {
    const first = splitLines("", "Compiling foo\nCompi");
    const second = splitLines(first.buffer, "ling bar\n");
    expect(second.lines).toEqual(["Compiling bar"]);
    expect(second.buffer).toBe("");
  });

  it("handles CRLF line endings", () => {
    const { lines, buffer } = splitLines("", "one\r\ntwo\r\n");
    expect(lines).toEqual(["one", "two"]);
    expect(buffer).toBe("");
  });

  it("returns no lines and the full buffer when there is no newline yet", () => {
    const { lines, buffer } = splitLines("", "partial line with no newline");
    expect(lines).toEqual([]);
    expect(buffer).toBe("partial line with no newline");
  });
});

describe("parseCompileTick", () => {
  it("parses a plain 'Compiling <crate> vX' line", () => {
    expect(parseCompileTick("   Compiling serde v1.0.190")).toEqual({ crate: "serde" });
  });

  it("parses cargo unit progress prefix '[N/M]'", () => {
    expect(parseCompileTick("[3/50] Compiling tauri v2.0.0")).toEqual({
      crate: "tauri",
      index: 3,
      total: 50
    });
  });

  it("returns undefined for unrelated output lines", () => {
    expect(parseCompileTick("warning: unused import")).toBeUndefined();
    expect(parseCompileTick("Finished release [optimized] target(s) in 12.3s")).toBeUndefined();
  });

  it("returns undefined for an empty line", () => {
    expect(parseCompileTick("")).toBeUndefined();
  });
});
