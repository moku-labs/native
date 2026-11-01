import { Buffer } from "node:buffer";
import { runInThisContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import type { BuildProfile } from "../../../../../config";
import { shellPageScript } from "../../../generators/shell/page-script";
import type { GeneratorInput } from "../../../generators/types";
import { generatorInputWith } from "./fixtures";

/** The IPC entry point the page script calls: `__TAURI_INTERNALS__.invoke`. */
type Invoke = (command: string, args?: unknown) => Promise<unknown>;

/** What a `moku-native:*` event carries in the fake page. */
type PageEvent = { type: string; detail: unknown };

/** The four safe-area insets, in CSS px. */
type Insets = { top: number; right: number; bottom: number; left: number };

/** The page contract v1, as the engine reads it. */
type MokuNative = {
  version: number;
  platform: string;
  build: { profile: string; id: string };
  device: { model: string; manufacturer: string; sdk: number } | null;
  ready: Promise<void>;
  display: { maxHz: number | null; setFrameRate(fps: number | null): Promise<unknown> };
  thermal: { read(): Promise<unknown> };
  insets: { current: Insets };
  share?: (file: { name: string; mime: string; bytes: Uint8Array }) => Promise<unknown>;
};

/** The console levels the debug profile forwards. */
type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

/** A minimal page global: IPC, console, the root element's style, events and `btoa`. No DOM lib. */
type FakePage = {
  __TAURI_INTERNALS__: { invoke: Invoke };
  __MOKU_NATIVE__?: MokuNative;
  __MOKU_NATIVE_PUSH__?: (kind: string, detail: unknown) => void;
  console: Record<ConsoleLevel, (...parts: unknown[]) => void>;
  document: { documentElement: { style: { setProperty(name: string, value: string): void } } };
  dispatchEvent(event: PageEvent): boolean;
  CustomEvent: new (type: string, init?: { detail?: unknown }) => PageEvent;
  btoa(binary: string): string;
  addEventListener(type: string, listener: () => void): void;
};

const APP = { name: "My Cool App", identifier: "com.example.mycoolapp" };

const INPUT = generatorInputWith("android", {
  app: { ...APP, version: "1.2.3", buildNumber: "7" }
});

/** Answers every call the script makes at start; a test overrides single commands. */
const answers =
  (overrides: Partial<Record<string, (args: unknown) => Promise<unknown>>> = {}): Invoke =>
  async (command, args) => {
    const name = command.replace("plugin:moku-shell|", "");
    const override = overrides[name];
    if (override) return override(args);
    if (name === "info") {
      return { device: { model: "SM-A266B", manufacturer: "samsung", sdk: 35 }, maxHz: 120 };
    }
    if (name === "insets") return { top: 0, right: 0, bottom: 0, left: 0 };
    return undefined;
  };

/** Lets the start-up IPC answers land. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Evaluates the generated `src/page.js` against a fresh fake page, the way the WebView runs
 * an init script at document start (`times: 2` evaluates it twice on the same page).
 */
function installPage(
  profile: BuildProfile,
  options: { invoke?: Invoke; input?: GeneratorInput; times?: number } = {}
) {
  const events: PageEvent[] = [];
  const style = new Map<string, string>();
  const original = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ipc = vi.fn(options.invoke ?? answers());
  const page: FakePage = {
    __TAURI_INTERNALS__: { invoke: ipc },
    console: { ...original },
    document: {
      documentElement: { style: { setProperty: (name, value) => style.set(name, value) } }
    },
    dispatchEvent: event => events.push(event) > 0,
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    btoa: binary => Buffer.from(binary, "latin1").toString("base64"),
    addEventListener: vi.fn()
  };

  const script = shellPageScript(options.input ?? INPUT, profile);
  const evaluate: (fake: FakePage) => void = runInThisContext(
    `(function (globalThis) {\n${script}\n})`
  );
  for (let run = 0; run < (options.times ?? 1); run += 1) evaluate(page);

  const shell = page.__MOKU_NATIVE__;
  if (!shell) throw new Error("the page script installed no __MOKU_NATIVE__");
  return { page, shell, ipc, events, style, original };
}

/** The IPC calls made for one shell command. */
const callsOf = (ipc: ReturnType<typeof installPage>["ipc"], command: string) =>
  ipc.mock.calls.filter(([name]) => name === `plugin:moku-shell|${command}`);

describe("shellPageScript — the page contract v1", () => {
  it("carries version 1, the platform, and the baked profile and build id (bug: a debug page reads as a store one)", () => {
    expect(installPage("debug").shell).toMatchObject({
      version: 1,
      platform: "android",
      build: { profile: "debug", id: "1.2.3+7-debug" }
    });
    expect(installPage("store").shell.build).toEqual({ profile: "release", id: "1.2.3+7" });

    const noBuildNumber = generatorInputWith("android", { app: { ...APP, version: "2.0.0" } });
    expect(installPage("store", { input: noBuildNumber }).shell.build.id).toBe("2.0.0+0");
  });

  it("the dev profile reads as release: no -debug id, no share, console untouched (bug: share or a console over IPC in a tester's build)", () => {
    const { page, shell, ipc, original } = installPage("dev");

    page.console.log("hello");

    expect(shell.build).toEqual({ profile: "release", id: "1.2.3+7" });
    expect("share" in shell).toBe(false);
    expect(page.console.log).toBe(original.log);
    expect(callsOf(ipc, "log")).toEqual([]);
  });

  it("a pushed insets sets the four CSS variables and dispatches moku-native:insets (bug: the page never sees the safe area)", async () => {
    const { page, shell, events, style } = installPage("store");
    await settle();

    page.__MOKU_NATIVE_PUSH__?.("insets", { top: 24, right: 0, bottom: 48, left: 0 });

    // Bug: written as --moku-safe-*, the inline insets beat a page's own --moku-safe-* rule, and
    // a HUD that adds a gap to the insets lay under the status bar (A26, 34 px instead of 55).
    expect(Object.fromEntries(style)).toEqual({
      "--moku-device-safe-top": "24px",
      "--moku-device-safe-right": "0px",
      "--moku-device-safe-bottom": "48px",
      "--moku-device-safe-left": "0px"
    });
    expect(events.at(-1)).toEqual({
      type: "moku-native:insets",
      detail: { top: 24, right: 0, bottom: 48, left: 0 }
    });
    expect(shell.insets.current).toEqual({ top: 24, right: 0, bottom: 48, left: 0 });
  });

  it("setFrameRate rejects a non-positive or non-finite fps without calling the shell (bug: a 0 Hz request reaches the panel)", async () => {
    const { shell, ipc } = installPage("store");

    await expect(shell.display.setFrameRate(0)).rejects.toThrow(TypeError);
    await expect(shell.display.setFrameRate(Number.NaN)).rejects.toThrow(TypeError);
    expect(callsOf(ipc, "set_frame_rate")).toEqual([]);

    await shell.display.setFrameRate(60);
    expect(callsOf(ipc, "set_frame_rate")).toEqual([
      ["plugin:moku-shell|set_frame_rate", { fps: 60 }]
    ]);
  });

  it("debug forwards console calls to the shell log and keeps the original (bug: no page console in logcat)", () => {
    const { page, ipc, original } = installPage("debug");

    page.console.warn("low fps", { fps: 41 });

    expect(original.warn).toHaveBeenCalledWith("low fps", { fps: 41 });
    expect(callsOf(ipc, "log")).toEqual([
      ["plugin:moku-shell|log", { level: "warn", message: 'low fps {"fps":41}' }]
    ]);
  });

  it("store leaves the console untouched (bug: a store app ships its console over IPC)", () => {
    const { page, ipc, original } = installPage("store");

    page.console.log("hello");

    expect(page.console.log).toBe(original.log);
    expect(callsOf(ipc, "log")).toEqual([]);
  });

  it("a second evaluation on the same page installs nothing twice (bug: every console line forwarded twice)", () => {
    const { page, ipc, original } = installPage("debug", { times: 2 });

    page.console.log("once");

    expect(original.log).toHaveBeenCalledTimes(1);
    expect(callsOf(ipc, "log")).toHaveLength(1);
  });

  it("device and display.maxHz stay null until info answers, then fill (bug: the log header reads no device)", async () => {
    const info = Promise.withResolvers<unknown>();
    const { shell } = installPage("store", { invoke: answers({ info: () => info.promise }) });

    expect(shell.device).toBeNull();
    expect(shell.display.maxHz).toBeNull();

    info.resolve({ device: { model: "SM-A266B", manufacturer: "samsung", sdk: 35 }, maxHz: 120 });
    await shell.ready;

    expect(shell.device).toEqual({ model: "SM-A266B", manufacturer: "samsung", sdk: 35 });
    expect(shell.display.maxHz).toBe(120);
  });

  it("ready resolves when info fails, leaving null (bug: the engine's log header waits forever)", async () => {
    const failing = answers({ info: () => Promise.reject(new Error("no shell")) });
    const { shell } = installPage("store", { invoke: failing });

    await expect(shell.ready).resolves.toBeUndefined();
    expect(shell.device).toBeNull();
    expect(shell.display.maxHz).toBeNull();
  });

  it("share exists only in the debug profile (bug: a share sheet reachable in a store app)", () => {
    expect("share" in installPage("store").shell).toBe(false);
    expect(installPage("debug").shell.share).toBeTypeOf("function");
  });

  it.each([
    ["a name that climbs out of the folder", "../x", 4],
    ["a dot-only name", "..", 4],
    ["33 MiB of bytes", "perf.log", 33 * 1024 * 1024]
  ])("share refuses %s before calling the shell (bug: path escape / IPC blow-up)", async (_label, name, size) => {
    const { shell, ipc } = installPage("debug");

    await expect(
      shell.share?.({ name, mime: "text/plain", bytes: new Uint8Array(size) })
    ).rejects.toThrow(TypeError);
    expect(callsOf(ipc, "share")).toEqual([]);
  });

  it("share sends the bytes base64-encoded, decoding to the same bytes (bug: a corrupted log)", async () => {
    const sharing = answers({ share: async () => ({ shared: true }) });
    const { shell, ipc } = installPage("debug", { invoke: sharing });
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31) % 256);

    await expect(shell.share?.({ name: "perf.log", mime: "text/plain", bytes })).resolves.toEqual({
      shared: true
    });
    expect(callsOf(ipc, "share")).toEqual([
      [
        "plugin:moku-shell|share",
        { name: "perf.log", mime: "text/plain", bytes: Buffer.from(bytes).toString("base64") }
      ]
    ]);
  });
});
