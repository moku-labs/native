/**
 * @file project plugin generator — the shell crate's Android library module: Gradle
 * build, manifest, R8 keep rules, `MokuShellPlugin.kt` and the per-profile
 * `MokuShellProfile.kt`.
 */
import type { BuildProfile } from "../../../../config";
import type { Artifact } from "../types";
import { SHELL_ANDROID_PACKAGE, SHELL_GENERATED_NOTICE } from "./rust";

/** Where the Kotlin sources live inside the module, one folder per package segment. */
const KOTLIN_DIRECTORY = `android/src/main/java/${SHELL_ANDROID_PACKAGE.replaceAll(".", "/")}`;

/**
 * The library module's Gradle build — the shape of the official Tauri plugins (haptics),
 * which build in the same generated project: Java/Kotlin 1.8 targets, `core-ktx` for
 * `ViewCompat`/`FileProvider`, `appcompat` for the `AppCompatActivity` in `Plugin`'s
 * lifecycle hooks, and the app's `:tauri-android` project for `Plugin`.
 */
const BUILD_GRADLE = `// ${SHELL_GENERATED_NOTICE}
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "${SHELL_ANDROID_PACKAGE}"
    compileSdk = 37

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("proguard-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation(project(":tauri-android"))
}
`;

/** The library manifest: the namespace comes from Gradle, so it declares nothing. */
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<!-- ${SHELL_GENERATED_NOTICE} -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android" />
`;

/** Consumer R8 rules: the app's release build is minified, and nothing here may be renamed. */
const PROGUARD_RULES = `# ${SHELL_GENERATED_NOTICE}
# Rust loads the plugin class by name and Jackson fills the argument classes by reflection.
-keep class ${SHELL_ANDROID_PACKAGE}.** { *; }
`;

/**
 * The native half of the page contract v1. Tauri runs every `@Command` on the UI thread
 * (wry's main pipe), so the slow part of `share` — decoding up to 32 MiB and writing the
 * file — goes to a background executor, and only `startActivity` comes back to the UI
 * thread. Window changes (`setFrameRate`) stay on the UI thread.
 */
const PLUGIN_KT = `// ${SHELL_GENERATED_NOTICE}
package ${SHELL_ANDROID_PACKAGE}

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.Display
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.roundToInt
import org.json.JSONObject

/** display.setFrameRate(fps): a target rate, or null for the system default. */
@InvokeArg
class FrameRateArgs {
    var fps: Double? = null
}

/** One console call forwarded by the debug page. */
@InvokeArg
class LogArgs {
    var level: String = "log"
    var message: String = ""
}

/** One file to share; the bytes arrive base64-encoded. */
@InvokeArg
class ShareArgs {
    var name: String = ""
    var mime: String = "application/octet-stream"
    var bytes: String = ""
}

/** The shell behind globalThis.__MOKU_NATIVE__: display rate, thermal, insets, log, share, info. */
@TauriPlugin
class MokuShellPlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private var lastInsets: JSObject = edges(0f, 0f, 0f, 0f)
    private var thermalListener: Any? = null
    private var headroom: Double? = null
    private var headroomAt = 0L
    // Off the UI thread: the share file is decoded and written here.
    private val io = Executors.newSingleThreadExecutor()

    override fun load(webView: WebView) {
        this.webView = webView
        if (MokuShellProfile.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
            val density = view.resources.displayMetrics.density
            val sides = windowInsets.getInsets(
                WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val bottom = windowInsets.getInsets(
                WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.displayCutout()
            )
            lastInsets = edges(sides.top / density, sides.right / density, bottom.bottom / density, sides.left / density)
            push("insets", lastInsets)
            // The WebView still applies the insets itself, so CSS env(safe-area-inset-*) keeps working.
            ViewCompat.onApplyWindowInsets(view, windowInsets)
            windowInsets
        }
        ViewCompat.requestApplyInsets(webView)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val listener = PowerManager.OnThermalStatusChangedListener { push("thermal", readThermal()) }
            powerManager().addThermalStatusListener(activity.mainExecutor, listener)
            thermalListener = listener
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        // Only this plugin's own activity going away ends the listener and the executor.
        if (activity === this.activity) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val listener = thermalListener as? PowerManager.OnThermalStatusChangedListener
                if (listener != null) powerManager().removeThermalStatusListener(listener)
            }
            thermalListener = null
            io.shutdown()
        }
        super.onDestroy(activity)
    }

    @Command
    fun setFrameRate(invoke: Invoke) {
        val args = invoke.parseArgs(FrameRateArgs::class.java)
        activity.runOnUiThread {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                invoke.resolve(rates(null, null))
                return@runOnUiThread
            }
            val display = currentDisplay()
            val modes = sameSizeModes(display)
            val fps = args.fps
            // The slowest mode at or above the asked rate; none: the fastest one there is.
            val chosen = if (fps == null) null else
                modes.filter { it.refreshRate >= fps - 0.5 }.minByOrNull { it.refreshRate }
                    ?: modes.maxByOrNull { it.refreshRate }
            val attributes = activity.window.attributes
            val modeId = chosen?.modeId ?: 0
            // The same preference again changes nothing, so no re-layout per call.
            if (attributes.preferredDisplayModeId != modeId) {
                attributes.preferredDisplayModeId = modeId
                attributes.preferredRefreshRate = chosen?.refreshRate ?: 0f
                activity.window.attributes = attributes
            }
            val panel = chosen ?: display.mode
            invoke.resolve(rates(panel.refreshRate.roundToInt(), topRate(display)))
        }
    }

    @Command
    fun thermal(invoke: Invoke) {
        invoke.resolve(readThermal())
    }

    @Command
    fun insets(invoke: Invoke) {
        invoke.resolve(lastInsets)
    }

    @Command
    fun log(invoke: Invoke) {
        val args = invoke.parseArgs(LogArgs::class.java)
        val priority = when (args.level) {
            "error" -> Log.ERROR
            "warn" -> Log.WARN
            "debug" -> Log.DEBUG
            else -> Log.INFO
        }
        Log.println(priority, "moku-page", args.message)
        invoke.resolve()
    }

    @Command
    fun share(invoke: Invoke) {
        if (!MokuShellProfile.DEBUG) {
            invoke.reject("share is a debug-build command")
            return
        }
        val args = invoke.parseArgs(ShareArgs::class.java)
        val name = args.name.replace(Regex("[^A-Za-z0-9._-]"), "").take(120)
        if (name.isEmpty() || name.all { it == '.' }) {
            invoke.reject("share needs a file name with a letter or a digit")
            return
        }
        // Called on the UI thread: decode, clear and write in the background, then come back.
        io.execute {
            try {
                val directory = File(activity.cacheDir, "moku-share")
                directory.deleteRecursively()
                directory.mkdirs()
                val file = File(directory, name)
                file.writeBytes(Base64.decode(args.bytes, Base64.DEFAULT))
                val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
                val send = Intent(Intent.ACTION_SEND)
                send.type = args.mime
                send.putExtra(Intent.EXTRA_STREAM, uri)
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                activity.runOnUiThread {
                    try {
                        activity.startActivity(Intent.createChooser(send, name))
                        val result = JSObject()
                        result.put("shared", true)
                        invoke.resolve(result)
                    } catch (error: Exception) {
                        invoke.reject("share failed: " + error.message)
                    }
                }
            } catch (error: Exception) {
                invoke.reject("share failed: " + error.message)
            }
        }
    }

    @Command
    fun info(invoke: Invoke) {
        val device = JSObject()
        device.put("model", Build.MODEL.trim())
        device.put("manufacturer", Build.MANUFACTURER)
        device.put("sdk", Build.VERSION.SDK_INT)
        val result = JSObject()
        result.put("device", device)
        result.put("maxHz", topRate(currentDisplay()) ?: JSONObject.NULL)
        invoke.resolve(result)
    }

    private fun push(kind: String, detail: JSObject) {
        val view = webView ?: return
        val script = "globalThis.__MOKU_NATIVE_PUSH__ && globalThis.__MOKU_NATIVE_PUSH__(" +
            JSONObject.quote(kind) + ", " + detail.toString() + ")"
        view.post { view.evaluateJavascript(script, null) }
    }

    private fun edges(top: Float, right: Float, bottom: Float, left: Float): JSObject {
        val result = JSObject()
        result.put("top", top.toDouble())
        result.put("right", right.toDouble())
        result.put("bottom", bottom.toDouble())
        result.put("left", left.toDouble())
        return result
    }

    private fun rates(panelHz: Int?, maxHz: Int?): JSObject {
        val result = JSObject()
        result.put("panelHz", panelHz ?: JSONObject.NULL)
        result.put("maxHz", maxHz ?: JSONObject.NULL)
        return result
    }

    @Suppress("DEPRECATION")
    private fun currentDisplay(): Display = activity.windowManager.defaultDisplay

    private fun sameSizeModes(display: Display): List<Display.Mode> {
        val current = display.mode
        return display.supportedModes.filter {
            it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight
        }
    }

    private fun topRate(display: Display): Int? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
        return sameSizeModes(display).maxOfOrNull { it.refreshRate }?.roundToInt()
    }

    private fun powerManager(): PowerManager =
        activity.getSystemService(Context.POWER_SERVICE) as PowerManager

    private fun readThermal(): JSObject {
        val power = powerManager()
        val status = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) power.currentThermalStatus else 0
        val headroom = readHeadroom(power)
        val raw = JSObject()
        raw.put("status", status)
        raw.put("headroom", headroom ?: JSONObject.NULL)
        raw.put("forecastSeconds", 10)
        val result = JSObject()
        result.put("status", THERMAL_STATUS.getOrElse(status) { "none" })
        result.put("headroom", headroom ?: JSONObject.NULL)
        result.put("at", System.currentTimeMillis())
        result.put("android", raw)
        return result
    }

    /** ADPF headroom over a 10 s forecast; polled faster than 1/s it answers NaN, so it is cached. */
    @Synchronized
    private fun readHeadroom(power: PowerManager): Double? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val now = SystemClock.elapsedRealtime()
        if (headroomAt == 0L || now - headroomAt >= 1000L) {
            val value = power.getThermalHeadroom(10)
            headroom = if (value.isNaN()) null else value.toDouble()
            headroomAt = now
        }
        return headroom
    }

    companion object {
        private val THERMAL_STATUS =
            listOf("none", "light", "moderate", "severe", "critical", "emergency", "shutdown")
    }
}
`;

/**
 * Renders `MokuShellProfile.kt`: the one per-profile file of the module. The debug profile
 * turns on WebView debugging and `share`; the store profile turns both off.
 *
 * @param profile - The build profile the crate is generated for.
 * @returns The Kotlin source.
 * @example
 * ```ts
 * profileKotlin("debug").includes("const val DEBUG = true"); // true
 * ```
 */
function profileKotlin(profile: BuildProfile): string {
  return `// ${SHELL_GENERATED_NOTICE}
package ${SHELL_ANDROID_PACKAGE}

/** Which build profile this shell was generated for. */
object MokuShellProfile {
    /** True in the debug profile: WebView debugging and share are on. */
    const val DEBUG = ${String(profile === "debug")}
}
`;
}

/**
 * Generates the shell crate's Android library module, paths relative to the crate root.
 * Only `MokuShellProfile.kt` differs per profile.
 *
 * @param profile - The build profile `MokuShellProfile.DEBUG` follows.
 * @returns Artifacts for the Gradle build, manifest, R8 rules and the two Kotlin files.
 * @example
 * ```ts
 * shellAndroidArtifacts("debug").at(-1)?.content.includes("const val DEBUG = true"); // true
 * ```
 */
export function shellAndroidArtifacts(profile: BuildProfile): Artifact[] {
  return [
    { path: "android/build.gradle.kts", content: BUILD_GRADLE },
    { path: "android/src/main/AndroidManifest.xml", content: MANIFEST },
    { path: "android/proguard-rules.pro", content: PROGUARD_RULES },
    { path: `${KOTLIN_DIRECTORY}/MokuShellPlugin.kt`, content: PLUGIN_KT },
    { path: `${KOTLIN_DIRECTORY}/MokuShellProfile.kt`, content: profileKotlin(profile) }
  ];
}
