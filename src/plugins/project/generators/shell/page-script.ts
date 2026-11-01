/**
 * @file project plugin generator — the shell crate's `src/page.js`: the page contract
 * `globalThis.__MOKU_NATIVE__` v1, installed before page scripts.
 */
import type { BuildProfile } from "../../../../config";
import type { GeneratorInput } from "../types";
import { SHELL_GENERATED_NOTICE } from "./rust";

/** The version the build id falls back to — the same default Cargo.toml and tauri.conf.json use. */
const DEFAULT_VERSION = "0.1.0";

/**
 * The contract itself, after the three baked constants (`PLATFORM`, `PROFILE`, `BUILD_ID`).
 * Plain ES2019 that reaches the page only through `globalThis`, so a test can run it
 * against a fake page. IPC goes through `__TAURI_INTERNALS__.invoke`, which every Tauri page
 * carries, looked up at call time. Additive changes keep `version: 1`.
 */
const CONTRACT_BODY = String.raw`  var MAX_SHARE_BYTES = 32 * 1024 * 1024;
  var MAX_LOG_CHARS = 4000;
  var LEVELS = ["log", "info", "warn", "error", "debug"];
  var state = {
    insets: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
    device: null,
    maxHz: null
  };

  function noop() {}

  function call(command, args) {
    try {
      return Promise.resolve(
        g.__TAURI_INTERNALS__.invoke("plugin:moku-shell|" + command, args || {})
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function edge(value) {
    return typeof value === "number" && isFinite(value) ? value : 0;
  }

  function dispatch(type, detail) {
    if (typeof g.dispatchEvent !== "function" || typeof g.CustomEvent !== "function") return;
    g.dispatchEvent(new g.CustomEvent(type, { detail: detail }));
  }

  // The system insets go in --moku-device-safe-*, never in --moku-safe-*: an inline property on
  // the root beats every stylesheet rule, so a page that sets --moku-safe-* from the insets (a gap
  // added to them) would lose its rule. A page reads them as
  // var(--moku-safe-top, var(--moku-device-safe-top, env(safe-area-inset-top))).
  function paintInsets() {
    var root = g.document && g.document.documentElement;
    if (!root) return false;
    root.style.setProperty("--moku-device-safe-top", state.insets.top + "px");
    root.style.setProperty("--moku-device-safe-right", state.insets.right + "px");
    root.style.setProperty("--moku-device-safe-bottom", state.insets.bottom + "px");
    root.style.setProperty("--moku-device-safe-left", state.insets.left + "px");
    return true;
  }

  // Called by the Kotlin shell through evaluateJavascript.
  function push(kind, detail) {
    if (kind === "insets" && detail) {
      state.insets = Object.freeze({
        top: edge(detail.top),
        right: edge(detail.right),
        bottom: edge(detail.bottom),
        left: edge(detail.left)
      });
      if (!paintInsets() && typeof g.addEventListener === "function") {
        g.addEventListener("DOMContentLoaded", paintInsets, { once: true });
      }
      dispatch("moku-native:insets", state.insets);
    } else if (kind === "thermal") {
      dispatch("moku-native:thermal", detail);
    }
  }

  function fill(answer) {
    if (!answer || typeof answer !== "object") return;
    var device = answer.device;
    if (device && typeof device === "object") {
      state.device = Object.freeze({
        model: String(device.model),
        manufacturer: String(device.manufacturer),
        sdk: Number(device.sdk)
      });
    }
    if (typeof answer.maxHz === "number") state.maxHz = answer.maxHz;
  }

  function toBase64(bytes) {
    var binary = "";
    for (var start = 0; start < bytes.length; start += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(start, start + 0x8000));
    }
    return g.btoa(binary);
  }

  function share(file) {
    var name = file && file.name;
    var bytes = file && file.bytes;
    if (typeof name !== "string" || name === "" || /[\/\\]/.test(name) || /^\.+$/.test(name)) {
      return Promise.reject(new TypeError("__MOKU_NATIVE__.share needs a plain file name"));
    }
    if (!(bytes instanceof Uint8Array)) {
      return Promise.reject(new TypeError("__MOKU_NATIVE__.share needs the bytes as a Uint8Array"));
    }
    if (bytes.length > MAX_SHARE_BYTES) {
      return Promise.reject(new TypeError("__MOKU_NATIVE__.share takes at most 32 MiB"));
    }
    var mime = typeof file.mime === "string" && file.mime ? file.mime : "application/octet-stream";
    return call("share", { name: name, mime: mime, bytes: toBase64(bytes) });
  }

  function describe(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || String(value);
    if (value !== null && typeof value === "object") {
      try {
        var json = JSON.stringify(value);
        if (typeof json === "string") return json;
      } catch {}
    }
    return String(value);
  }

  // Debug only: every console call still runs, and also reaches logcat as "moku-page".
  function forwardConsole() {
    var target = g.console;
    if (!target) return;
    LEVELS.forEach(function (level) {
      var original = target[level];
      if (typeof original !== "function") return;
      target[level] = function () {
        original.apply(target, arguments);
        var parts = [];
        for (var index = 0; index < arguments.length; index += 1) {
          parts.push(describe(arguments[index]));
        }
        var message = parts.join(" ");
        if (message.length > MAX_LOG_CHARS) message = message.slice(0, MAX_LOG_CHARS);
        call("log", { level: level, message: message }).catch(noop);
      };
    });
  }

  var display = Object.freeze({
    get maxHz() {
      return state.maxHz;
    },
    setFrameRate: function (fps) {
      if (fps !== null && !(typeof fps === "number" && isFinite(fps) && fps > 0)) {
        return Promise.reject(
          new TypeError("__MOKU_NATIVE__.display.setFrameRate needs a positive fps, or null")
        );
      }
      return call("set_frame_rate", { fps: fps });
    }
  });

  var shell = {
    version: 1,
    platform: PLATFORM,
    build: Object.freeze({ profile: PROFILE, id: BUILD_ID }),
    get device() {
      return state.device;
    },
    // Resolves once the one info call answered, or failed: never rejects, never hangs.
    ready: call("info").then(fill).then(noop, noop),
    display: display,
    thermal: Object.freeze({
      read: function () {
        return call("thermal");
      }
    }),
    insets: Object.freeze({
      get current() {
        return state.insets;
      }
    })
  };
  if (PROFILE === "debug") shell.share = share;

  Object.defineProperty(g, "__MOKU_NATIVE_PUSH__", { value: push });
  Object.defineProperty(g, "__MOKU_NATIVE__", { value: Object.freeze(shell), enumerable: true });

  if (PROFILE === "debug") forwardConsole();
  // A push that came before this script is lost; the shell's last insets cover it.
  call("insets").then(function (answer) {
    push("insets", answer);
  }, noop);`;

/**
 * Builds the page contract script for one app and profile. The build profile and id are
 * baked in at generate time: the store and dev profiles read `"release"` on the page, and the
 * id is `"<app.version>+<app.buildNumber ?? 0>"`, with `"-debug"` in the debug profile. A second
 * run of the script in the same frame is a no-op.
 *
 * @param input - The generator input (target, app version and build number).
 * @param profile - The build profile baked into the script.
 * @returns The `src/page.js` text.
 * @example
 * ```ts
 * shellPageScript(input, "debug").includes('var BUILD_ID = "1.2.3+7-debug";'); // true for 1.2.3, build 7
 * ```
 */
export function shellPageScript(input: GeneratorInput, profile: BuildProfile): string {
  const { version, buildNumber } = input.global.app;
  const build = `${version ?? DEFAULT_VERSION}+${buildNumber ?? "0"}`;
  const id = profile === "debug" ? `${build}-debug` : build;
  const pageProfile = profile === "debug" ? "debug" : "release";

  return [
    `// ${SHELL_GENERATED_NOTICE}`,
    "// The page contract globalThis.__MOKU_NATIVE__ v1.",
    "(function () {",
    '  "use strict";',
    "  var g = globalThis;",
    "  if (g.__MOKU_NATIVE__) return;",
    "",
    `  var PLATFORM = ${JSON.stringify(input.target)};`,
    `  var PROFILE = ${JSON.stringify(pageProfile)};`,
    `  var BUILD_ID = ${JSON.stringify(id)};`,
    CONTRACT_BODY,
    "})();",
    ""
  ].join("\n");
}
