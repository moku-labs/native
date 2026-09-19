import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeableProcess } from "../../spawn";
import { killProcessGroup, MAX_BUFFERED_STREAM_CHARS, realSpawn } from "../../spawn";

describe("killProcessGroup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("escalates SIGTERM -> SIGKILL when the process ignores the grace period", async () => {
    const sendSignal = vi.fn();
    const proc: FakeableProcess = { pid: 4242, exited: false, onExit: () => {} };

    const promise = killProcessGroup(proc, { graceMs: 2000, platform: "darwin", sendSignal });
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(sendSignal).toHaveBeenNthCalledWith(1, -4242, "SIGTERM");
    expect(sendSignal).toHaveBeenNthCalledWith(2, -4242, "SIGKILL");
  });

  it("resolves without escalating when the process exits inside the grace period", async () => {
    const sendSignal = vi.fn();
    let exitListener: (() => void) | undefined;
    const proc: FakeableProcess = {
      pid: 99,
      exited: false,
      onExit: listener => {
        exitListener = listener;
      }
    };

    const promise = killProcessGroup(proc, { graceMs: 2000, platform: "darwin", sendSignal });
    exitListener?.();
    await promise;

    expect(sendSignal).toHaveBeenCalledTimes(1);
    expect(sendSignal).toHaveBeenCalledWith(-99, "SIGTERM");
  });

  it("uses taskkill on Windows instead of POSIX group signals", async () => {
    const taskkill = vi.fn();
    const sendSignal = vi.fn();
    const proc: FakeableProcess = { pid: 55, exited: false, onExit: () => {} };

    await killProcessGroup(proc, { platform: "win32", taskkill, sendSignal });

    expect(taskkill).toHaveBeenCalledWith(55);
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it("resolves immediately when the process has no pid", async () => {
    const sendSignal = vi.fn();
    const proc: FakeableProcess = { pid: undefined, exited: false, onExit: () => {} };
    await expect(killProcessGroup(proc, { sendSignal })).resolves.toBeUndefined();
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it("resolves immediately when the process has already exited", async () => {
    const sendSignal = vi.fn();
    const proc: FakeableProcess = { pid: 7, exited: true, onExit: () => {} };
    await expect(killProcessGroup(proc, { sendSignal })).resolves.toBeUndefined();
    expect(sendSignal).not.toHaveBeenCalled();
  });
});

describe("realSpawn", () => {
  it("spawns a real process and captures stdout/stderr/exit code", async () => {
    const result = await realSpawn({
      cmd: [
        process.execPath,
        "-e",
        "console.log('hello'); console.error('oops'); process.exit(3);"
      ],
      cwd: process.cwd()
    });
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("hello");
    expect(result.stderr).toContain("oops");
  });

  it("streams complete lines via onLine as they arrive", async () => {
    const lines: string[] = [];
    await realSpawn({
      cmd: [process.execPath, "-e", "console.log('a'); console.log('b');"],
      cwd: process.cwd(),
      onLine: line => lines.push(line)
    });
    expect(lines).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("rejects when given an empty argv", async () => {
    await expect(realSpawn({ cmd: [], cwd: process.cwd() })).rejects.toThrow(/empty argv/);
  });

  it("passes extra env entries through to the child process", async () => {
    const result = await realSpawn({
      cmd: [process.execPath, "-e", "console.log(process.env.TAURI_TEST_VAR ?? 'missing')"],
      cwd: process.cwd(),
      env: { TAURI_TEST_VAR: "present" }
    });
    expect(result.stdout).toContain("present");
  });

  it("caps the buffered stdout to a bounded tail (long-lived dev sessions must not grow unbounded)", async () => {
    const overshoot = MAX_BUFFERED_STREAM_CHARS + 50_000;
    const result = await realSpawn({
      cmd: [process.execPath, "-e", `process.stdout.write("x".repeat(${overshoot - 4}) + "TAIL");`],
      cwd: process.cwd()
    });
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_BUFFERED_STREAM_CHARS);
    expect(result.stdout.endsWith("TAIL")).toBe(true);
  }, 10_000);

  it("keeps output written between the `exit` and `close` events", async () => {
    // The child exits at once, but a grandchild keeps the inherited stdout pipe open and
    // writes AFTER that exit — output only a `close`-based resolution can observe (the
    // real shape of tauri's own child xcodebuild/gradle processes).
    const grandchild = "setTimeout(() => process.stdout.write('LATE'), 200)";
    const script =
      "const { spawn } = require('node:child_process');" +
      `spawn(process.execPath, ['-e', "${grandchild}"], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();` +
      "process.exit(0);";

    const result = await realSpawn({ cmd: [process.execPath, "-e", script], cwd: process.cwd() });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("LATE");
  }, 10_000);

  it("group-kills a detached child when the abort signal fires", async () => {
    const controller = new AbortController();
    const promise = realSpawn({
      cmd: [process.execPath, "-e", "setTimeout(() => {}, 5000);"],
      cwd: process.cwd(),
      detached: true,
      signal: controller.signal
    });
    controller.abort();
    const result = await promise;
    expect(result.code === null || result.signal !== null).toBe(true);
  }, 10_000);
});
