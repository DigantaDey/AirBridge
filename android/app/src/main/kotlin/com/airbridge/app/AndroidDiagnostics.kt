package com.airbridge.app

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.airbridge.app.ui.viewmodels.AirBridgeAppUiState
import com.airbridge.engine.EngineDiagnosticsSnapshot
import com.airbridge.engine.JsonValue
import com.airbridge.engine.LocalNetworks
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.net.URI
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Redacted in-app diagnostics collector, bounded 400-line event ring, and
 * uncaught exception crash-breadcrumb recorder stored in `noBackupFilesDir`.
 *
 * Mirrors desktop `src/server/diagnostics.ts` while capturing Android-specific
 * FGS, wake/wifi lock hold durations, runtime permissions (including Android 16/17
 * `ACCESS_LOCAL_NETWORK`), NSD, BLE GATT, MediaProjection, QR decode, and storage health.
 */
object AndroidDiagnostics {
    const val MAX_LOG_ENTRIES = 400
    const val CRASH_BREADCRUMB_FILENAME = "airbridge_last_crash.json"
    const val PERMISSION_ACCESS_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"

    data class DiagnosticLogEntry(
        val timestampMs: Long,
        val level: String,
        val category: String,
        val message: String,
    ) {
        fun toJson(): JsonValue.Obj = JsonValue.Obj()
            .put("timestampMs", timestampMs)
            .put("level", level)
            .put("category", category)
            .put("message", message)
    }

    private val logLock = Any()
    private val logRing = ArrayDeque<DiagnosticLogEntry>(MAX_LOG_ENTRIES + 1)
    private val crashHandlerInstalled = AtomicBoolean(false)

    // Service / FGS telemetry
    @Volatile var fgsPromoted: Boolean = false
    @Volatile var fgsLastStartError: String? = null
    private val fgsTimeoutCounter = AtomicLong(0L)
    val fgsTimeoutCount: Long get() = fgsTimeoutCounter.get()

    // NSD telemetry
    @Volatile var nsdActive: Boolean = false
    private val nsdDiscoveredCounter = AtomicInteger(0)
    val nsdDiscoveredCount: Int get() = nsdDiscoveredCounter.get()
    @Volatile var nsdLastErrorCode: Int? = null
    private val nsdResolveTimeoutCounter = AtomicLong(0L)
    val nsdResolveTimeouts: Long get() = nsdResolveTimeoutCounter.get()

    // BLE / Handoff telemetry (never stores SSID or PSK)
    @Volatile var bleGattState: String = "idle"
    @Volatile var bleLastStatus: Int? = null
    @Volatile var bleMtu: Int? = null

    // ScreenShare telemetry
    @Volatile var screenShareActive: Boolean = false
    @Volatile var screenShareAudioAvailable: Boolean = false
    @Volatile var screenShareAudioPermissionGranted: Boolean = false
    @Volatile var screenShareAudioRecordState: String = "idle"
    @Volatile var screenCodecConfigCached: Boolean = false
    private val screenKeyFramesSentCounter = AtomicLong(0L)
    private val screenFramesDroppedCounter = AtomicLong(0L)
    private val screenPliReceivedCounter = AtomicLong(0L)
    fun recordScreenCodecConfigCached() { screenCodecConfigCached = true }
    fun recordScreenKeyFrameSent() { screenKeyFramesSentCounter.incrementAndGet() }
    fun recordScreenFrameDropped() { screenFramesDroppedCounter.incrementAndGet() }
    fun recordScreenPliReceived() { screenPliReceivedCounter.incrementAndGet() }

    // Clipboard Image telemetry
    private val clipboardImagesReceivedCounter = AtomicLong(0L)
    private val clipboardImageEchoesSuppressedCounter = AtomicLong(0L)
    fun recordClipboardImageReceived() { clipboardImagesReceivedCounter.incrementAndGet() }
    fun recordClipboardImageSuppressedEcho() { clipboardImageEchoesSuppressedCounter.incrementAndGet() }

    // Call Audio telemetry
    @Volatile var callAudioActive: Boolean = false
    @Volatile var callAudioLastError: String? = null
    private val callAudioFramesSentCounter = AtomicLong(0L)
    private val callAudioFramesReceivedCounter = AtomicLong(0L)
    fun recordCallAudioFrameSent() { callAudioFramesSentCounter.incrementAndGet() }
    fun recordCallAudioFrameReceived() { callAudioFramesReceivedCounter.incrementAndGet() }

    // QR decode telemetry
    private val qrFrameCounter = AtomicLong(0L)
    private val qrDecodeTotalNs = AtomicLong(0L)
    private val qrDroppedCounter = AtomicLong(0L)
    val qrFramesCount: Long get() = qrFrameCounter.get()
    val qrFramesDropped: Long get() = qrDroppedCounter.get()
    val qrAvgDecodeMs: Double
        get() {
            val count = qrFrameCounter.get()
            return if (count <= 0L) 0.0 else (qrDecodeTotalNs.get().toDouble() / count) / 1_000_000.0
        }

    // Storage telemetry
    @Volatile var storageSinkType: String = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "mediastore" else "staging"
    @Volatile var storageLastError: String? = null

    // Bitmap cache telemetry
    private val bitmapHitsCounter = AtomicLong(0L)
    private val bitmapMissesCounter = AtomicLong(0L)
    val bitmapCacheHits: Long get() = bitmapHitsCounter.get()
    val bitmapCacheMisses: Long get() = bitmapMissesCounter.get()

    // Network callback telemetry
    @Volatile var defaultNetworkPresent: Boolean = false
    @Volatile var wifiNetworkPresent: Boolean = false
    private val reconnectTriggerCounter = AtomicLong(0L)
    val networkReconnectTriggers: Long get() = reconnectTriggerCounter.get()

    fun recordFgsTimeout() {
        fgsTimeoutCounter.incrementAndGet()
    }

    fun recordNsdDiscovered(count: Int) {
        nsdDiscoveredCounter.set(count.coerceAtLeast(0))
    }

    fun recordNsdResolveTimeout() {
        nsdResolveTimeoutCounter.incrementAndGet()
    }

    fun recordQrDecodeSample(elapsedNs: Long) {
        qrFrameCounter.incrementAndGet()
        qrDecodeTotalNs.addAndGet(elapsedNs.coerceAtLeast(0L))
    }

    fun recordQrFrameDropped() {
        qrDroppedCounter.incrementAndGet()
    }

    fun recordBitmapCacheHit() {
        bitmapHitsCounter.incrementAndGet()
    }

    fun recordBitmapCacheMiss() {
        bitmapMissesCounter.incrementAndGet()
    }

    fun recordNetworkReconnectTrigger() {
        reconnectTriggerCounter.incrementAndGet()
    }

    // Regex patterns for secret and PII scrubbing
    private val querySecretRegex = Regex(
        """(?i)\b(pair|paircode|pendingpaircode|token|ca|key|psk|password|passphrase|secret|pin|beacon|auth)\s*([=:])\s*([^\s&"',;\]})]+)""",
    )
    private val jsonSecretRegex = Regex(
        """(?i)"(pair|pairCode|pendingPairCode|token|ca|key|psk|password|passphrase|secret|tlsPin|beacon)"\s*:\s*"([^"]*)"""",
    )
    private val bearerRegex = Regex("""(?i)\b(Authorization\s*:\s*Bearer|Bearer)\s+[A-Za-z0-9._~+/=-]+""")
    private val unixHomeRegex = Regex("""/(Users|home)/[^/\s"',;]+""")
    private val windowsHomeRegex = Regex("""(?i)[A-Z]:\\Users\\[^\\\s"',;]+""")
    private val macAddressRegex = Regex("""\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b""")
    private val emailRegex = Regex("""\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b""")

    /**
     * Scrubs pairing codes, tokens, TLS/CA pins, Wi-Fi PSKs, keys, home directories,
     * MAC addresses, and email addresses from diagnostic strings.
     */
    fun redact(text: String): String {
        if (text.isEmpty()) return text
        var out = text
        out = jsonSecretRegex.replace(out) { m -> "\"${m.groupValues[1]}\":\"[REDACTED]\"" }
        out = querySecretRegex.replace(out) { m -> "${m.groupValues[1]}${m.groupValues[2]}[REDACTED]" }
        out = bearerRegex.replace(out) { m -> "${m.groupValues[1]} [REDACTED]" }
        out = unixHomeRegex.replace(out) { m -> "/${m.groupValues[1]}/[REDACTED]" }
        out = windowsHomeRegex.replace(out, """C:\\Users\\[REDACTED]""")
        out = macAddressRegex.replace(out, "[REDACTED_MAC]")
        out = emailRegex.replace(out, "[REDACTED_EMAIL]")
        return out
    }

    /** Extracts only scheme://host:port from a target URL, stripping any query parameters or credentials. */
    fun sanitizeTargetEndpoint(rawTarget: String): String {
        val trimmed = rawTarget.trim()
        if (trimmed.isEmpty()) return ""
        val parsed = runCatching { URI(trimmed) }.getOrNull()
        if (parsed != null && !parsed.host.isNullOrBlank()) {
            val scheme = parsed.scheme ?: "https"
            val host = parsed.host
            val portPart = if (parsed.port > 0) ":${parsed.port}" else ""
            return "$scheme://$host$portPart"
        }
        return redact(trimmed.substringBefore('?').substringBefore('#'))
    }

    fun recordEvent(
        category: String,
        message: String,
        level: String = "INFO",
        timestampMs: Long = System.currentTimeMillis(),
    ) {
        val entry = DiagnosticLogEntry(
            timestampMs = timestampMs,
            level = level.uppercase(),
            category = redact(category.take(40)),
            message = redact(message.take(1000)),
        )
        synchronized(logLock) {
            while (logRing.size >= MAX_LOG_ENTRIES) {
                logRing.removeFirst()
            }
            logRing.addLast(entry)
        }
    }

    fun logsSnapshot(): List<DiagnosticLogEntry> = synchronized(logLock) { logRing.toList() }

    fun clearLogs() = synchronized(logLock) { logRing.clear() }

    fun installUncaughtExceptionHandler(context: Context) {
        val dir = context.applicationContext.noBackupFilesDir
        if (!crashHandlerInstalled.compareAndSet(false, true)) return
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching {
                writeCrashBreadcrumb(dir, thread.name, throwable)
            }
            previous?.uncaughtException(thread, throwable)
        }
    }

    fun writeCrashBreadcrumb(
        noBackupDir: File,
        threadName: String,
        throwable: Throwable,
        timestampMs: Long = System.currentTimeMillis(),
    ): JsonValue.Obj {
        if (!noBackupDir.isDirectory) noBackupDir.mkdirs()
        val sw = StringWriter()
        throwable.printStackTrace(PrintWriter(sw))
        val scrubbedStack = redact(
            sw.toString()
                .lineSequence()
                .take(35)
                .joinToString("\n")
                .take(4096),
        )
        val obj = JsonValue.Obj()
            .put("timestampMs", timestampMs)
            .put("threadName", redact(threadName.take(80)))
            .put("exceptionClass", throwable.javaClass.name)
            .put("message", redact(throwable.message.orEmpty().take(500)))
            .put("stackTrace", scrubbedStack)
        val file = File(noBackupDir, CRASH_BREADCRUMB_FILENAME)
        runCatching { file.writeText(obj.toJsonString(), Charsets.UTF_8) }
        return obj
    }

    fun readCrashBreadcrumb(noBackupDir: File?): JsonValue.Obj? {
        if (noBackupDir == null) return null
        val file = File(noBackupDir, CRASH_BREADCRUMB_FILENAME)
        if (!file.isFile) return null
        return runCatching { JsonValue.parseObject(file.readText(Charsets.UTF_8)) }.getOrNull()
    }

    fun clearCrashBreadcrumb(noBackupDir: File?) {
        if (noBackupDir == null) return
        runCatching { File(noBackupDir, CRASH_BREADCRUMB_FILENAME).delete() }
    }

    fun isLocalNetworkPermissionGranted(context: Context, sdkInt: Int = Build.VERSION.SDK_INT): Boolean {
        if (sdkInt < 36) return true
        return runCatching {
            ContextCompat.checkSelfPermission(context, PERMISSION_ACCESS_LOCAL_NETWORK) ==
                PackageManager.PERMISSION_GRANTED
        }.getOrDefault(true)
    }

    fun collectPermissionsSnapshot(context: Context?, sdkInt: Int = Build.VERSION.SDK_INT): Map<String, Boolean> {
        if (context == null) {
            return mapOf(
                "camera" to false,
                "notifications" to (sdkInt < Build.VERSION_CODES.TIRAMISU),
                "contacts" to false,
                "calls" to false,
                "nearbyWifi" to false,
                "bluetooth" to (sdkInt < Build.VERSION_CODES.S),
                "recordAudio" to false,
                "localNetwork" to true,
            )
        }
        fun granted(perm: String): Boolean =
            runCatching {
                ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
            }.getOrDefault(false)

        val notifications = if (sdkInt >= Build.VERSION_CODES.TIRAMISU) {
            granted(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            true
        }
        val nearbyWifi = if (sdkInt >= Build.VERSION_CODES.TIRAMISU) {
            granted(Manifest.permission.NEARBY_WIFI_DEVICES)
        } else {
            granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)
        }
        val bluetooth = if (sdkInt >= Build.VERSION_CODES.S) {
            granted(Manifest.permission.BLUETOOTH_SCAN) && granted(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            true
        }
        val calls = ContinuityPermissions.CALLS.all { granted(it) }
        return linkedMapOf(
            "camera" to granted(Manifest.permission.CAMERA),
            "notifications" to notifications,
            "contacts" to granted(Manifest.permission.READ_CONTACTS),
            "calls" to calls,
            "nearbyWifi" to nearbyWifi,
            "bluetooth" to bluetooth,
            "recordAudio" to granted(Manifest.permission.RECORD_AUDIO),
            "localNetwork" to isLocalNetworkPermissionGranted(context, sdkInt),
        )
    }

    fun collectReportJson(
        context: Context? = null,
        extraState: AirBridgeAppUiState? = null,
        engineSnapshotOverride: EngineDiagnosticsSnapshot? = null,
        noBackupDirOverride: File? = null,
    ): JsonValue.Obj {
        val sdkInt = runCatching { Build.VERSION.SDK_INT }.getOrDefault(35)
        val host = ConnectionService.currentHost()
        val engineSnap = engineSnapshotOverride ?: host?.diagnosticsSnapshot()
        val prefs = context?.let { runCatching { Prefs(it) }.getOrNull() }
        val rawTarget = extraState?.configuredTarget?.ifBlank { prefs?.target.orEmpty() }
            ?: prefs?.target.orEmpty()
        val sanitizedTarget = sanitizeTargetEndpoint(rawTarget)

        val batteryExempt = extraState?.batteryExempt ?: runCatching {
            val pm = context?.getSystemService(Context.POWER_SERVICE) as? PowerManager
            pm?.isIgnoringBatteryOptimizations(context.packageName) ?: false
        }.getOrDefault(false)

        val appObj = JsonValue.Obj()
            .put("versionName", BuildConfig.VERSION_NAME)
            .put("versionCode", BuildConfig.VERSION_CODE.toLong())
            .put("packageName", context?.packageName ?: "com.airbridge.app")
            .put("backupPolicyConfigured", true)

        val abisArr = JsonValue.JsonArr()
        runCatching { Build.SUPPORTED_ABIS?.forEach { abisArr.add(JsonValue.JsonStr(it)) } }
        val deviceObj = JsonValue.Obj()
            .put("manufacturer", Build.MANUFACTURER ?: "unknown")
            .put("model", Build.MODEL ?: "unknown")
            .put("release", Build.VERSION.RELEASE ?: "unknown")
            .put("sdkInt", sdkInt.toLong())
            .put("abis", abisArr)
            .put("uptimeMs", runCatching { SystemClock.elapsedRealtime() }.getOrDefault(0L))

        val permsMap = collectPermissionsSnapshot(context, sdkInt)
        val permsObj = JsonValue.Obj()
        for ((k, v) in permsMap) {
            permsObj.put(k, v)
        }

        val fgsObj = JsonValue.Obj()
            .put("promoted", ConnectionService.isForegroundPromoted() || fgsPromoted)
            .putOpt("lastStartError", fgsLastStartError?.let(::redact))
            .put("timeoutCount", fgsTimeoutCount)
            .put("uiAttached", ConnectionService.isUiAttached())
            .put("engineGeneration", ConnectionService.currentEngineGeneration())

        val powerObj = JsonValue.Obj()
            .put("wakeLockHeldMs", ConnectionService.totalWakeLockHeldMs())
            .put("wifiLockHeldMs", ConnectionService.totalWifiLockHeldMs())
            .put("wakeLockCurrentlyHeld", ConnectionService.isWakeLockHeld())
            .put("wifiLockCurrentlyHeld", ConnectionService.isWifiLockHeld())
            .put("batteryExempt", batteryExempt)

        val localNetsArr = JsonValue.JsonArr()
        runCatching {
            LocalNetworks.snapshot().forEach { addr ->
                val likelyHotspot = addr.interfaceName.startsWith("ap", ignoreCase = true) ||
                    addr.interfaceName.startsWith("swlan", ignoreCase = true) ||
                    addr.interfaceName.startsWith("softap", ignoreCase = true)
                localNetsArr.add(
                    JsonValue.Obj()
                        .put("interface", addr.interfaceName)
                        .put("address", addr.address)
                        .put("prefixLength", addr.prefixLength.toLong())
                        .put("isLan", addr.isLan)
                        .put("likelyHotspotDownlink", likelyHotspot),
                )
            }
        }

        val attemptsArr = JsonValue.JsonArr()
        engineSnap?.lastAttempts?.forEach { attempt ->
            attemptsArr.add(
                JsonValue.Obj()
                    .put("host", redact(attempt.host))
                    .put("port", attempt.port.toLong())
                    .put("kind", attempt.kind.name)
                    .putOpt("routeSource", attempt.routeSource)
                    .put("detail", redact(attempt.detail)),
            )
        }

        val connectionStateName = engineSnap?.connectionState?.name
            ?: extraState?.engine?.connectionState?.name
            ?: "DISCONNECTED"
        val viaRelay = engineSnap?.connectedViaRelay ?: extraState?.engine?.viaRelay ?: false
        val connectivityObj = JsonValue.Obj()
            .put("connectionState", connectionStateName)
            .put("viaRelay", viaRelay)
            .putOpt("admission", engineSnap?.admission)
            .put("configuredTarget", sanitizedTarget)
            .put("localNetworks", localNetsArr)
            .put("tlsMode", engineSnap?.tlsMode ?: "none")
            .put("tlsPinPresent", engineSnap?.tlsAnchored ?: false)
            .putOpt("tlsAnchorPrefix", engineSnap?.anchorPinPrefix)
            .putOpt("verifiedIpSanHost", engineSnap?.verifiedIpSanHost)
            .putOpt("connectedHost", engineSnap?.connectedHost)
            .put("connectedViaReverse", engineSnap?.connectedViaReverse ?: false)
            .putOpt("reversePort", engineSnap?.reversePort?.toLong())
            .put("wsConnectAttempts", engineSnap?.wsConnectAttempts ?: 0L)
            .putOpt("wsLastDnsMs", engineSnap?.wsLastDnsMs)
            .put("wsWriteStallCount", engineSnap?.wsWriteStallCount ?: 0L)
            .put("wsActiveDialThreads", (engineSnap?.wsActiveDialThreads ?: 0).toLong())
            .put("defaultNetworkPresent", defaultNetworkPresent)
            .put("wifiNetworkPresent", wifiNetworkPresent)
            .put("networkReconnectTriggers", networkReconnectTriggers)
            .put("endpointAttempts", attemptsArr)

        val nsdObj = JsonValue.Obj()
            .put("active", nsdActive)
            .put("discoveredCount", nsdDiscoveredCount.toLong())
            .putOpt("lastErrorCode", nsdLastErrorCode?.toLong())
            .put("resolveTimeouts", nsdResolveTimeouts)

        val handoffState = extraState?.engine?.handoff ?: host?.handoff?.state
        val handoffObj = JsonValue.Obj()
            .put("phase", handoffState?.phase?.name ?: "IDLE")
            .put("available", handoffState?.available ?: false)
            .put("active", handoffState?.active ?: false)

        val bleObj = JsonValue.Obj()
            .put("gattState", bleGattState)
            .putOpt("lastStatus", bleLastStatus?.toLong())
            .putOpt("mtu", bleMtu?.toLong())
            .put("sdkInt", sdkInt.toLong())

        val screenShareObj = JsonValue.Obj()
            .put("active", ScreenShareService.activeSessionId != null || screenShareActive)
            .put("audioAvailable", screenShareAudioAvailable)
            .put("audioPermissionGranted", permsMap["recordAudio"] == true || screenShareAudioPermissionGranted)
            .put("audioRecordInitState", screenShareAudioRecordState)
            .put("codecConfigCached", screenCodecConfigCached)
            .put("keyFramesSent", screenKeyFramesSentCounter.get())
            .put("framesDropped", screenFramesDroppedCounter.get())
            .put("pliReceived", screenPliReceivedCounter.get())

        val clipboardImagesObj = JsonValue.Obj()
            .put("received", clipboardImagesReceivedCounter.get())
            .put("suppressedEchoes", clipboardImageEchoesSuppressedCounter.get())

        val callAudioObj = JsonValue.Obj()
            .put("active", callAudioActive)
            .put("framesSent", callAudioFramesSentCounter.get())
            .put("framesReceived", callAudioFramesReceivedCounter.get())
            .putOpt("lastError", callAudioLastError?.let(::redact))

        val engineObj = JsonValue.Obj()
            .put("transferResumes", engineSnap?.transferResumes ?: 0L)
            .put("transferInterruptions", engineSnap?.transferInterruptions ?: 0L)
            .put("outboundBatchFlushes", engineSnap?.outboundBatchFlushes ?: 0L)

        val qrObj = JsonValue.Obj()
            .put("framesDecoded", qrFramesCount)
            .put("avgDecodeMs", JsonValue.JsonDouble(qrAvgDecodeMs))
            .put("framesDropped", qrFramesDropped)

        val storageObj = JsonValue.Obj()
            .put("sinkType", storageSinkType)
            .putOpt("lastError", storageLastError?.let(::redact))

        val uiObj = JsonValue.Obj()
            .put("bitmapCacheHits", bitmapCacheHits)
            .put("bitmapCacheMisses", bitmapCacheMisses)
            .put("scannerOpen", extraState?.scannerOpen ?: false)

        val crashDir = noBackupDirOverride ?: context?.noBackupFilesDir
        val crashObj = readCrashBreadcrumb(crashDir)

        val logsArr = JsonValue.JsonArr()
        for (entry in logsSnapshot()) {
            logsArr.add(entry.toJson())
        }

        val root = JsonValue.Obj()
            .put("generatedAtMs", System.currentTimeMillis())
            .put("app", appObj)
            .put("device", deviceObj)
            .put("permissions", permsObj)
            .put("batteryExempt", batteryExempt)
            .put("fgs", fgsObj)
            .put("power", powerObj)
            .put("connectivity", connectivityObj)
            .put("nsd", nsdObj)
            .put("handoff", handoffObj)
            .put("ble", bleObj)
            .put("screenShare", screenShareObj)
            .put("clipboardImages", clipboardImagesObj)
            .put("callAudio", callAudioObj)
            .put("engine", engineObj)
            .put("qr", qrObj)
            .put("storage", storageObj)
            .put("ui", uiObj)
            .put("logs", logsArr)
        if (crashObj != null) {
            root.put("crashBreadcrumb", crashObj)
        } else {
            root.put("crashBreadcrumb", JsonValue.JsonNull)
        }
        return root
    }

    fun formatShareableReport(
        context: Context? = null,
        extraState: AirBridgeAppUiState? = null,
        engineSnapshotOverride: EngineDiagnosticsSnapshot? = null,
        noBackupDirOverride: File? = null,
    ): String {
        val json = collectReportJson(
            context = context,
            extraState = extraState,
            engineSnapshotOverride = engineSnapshotOverride,
            noBackupDirOverride = noBackupDirOverride,
        )
        return redact(
            buildString {
                appendLine("=== AirBridge Android Diagnostic Report ===")
                appendLine("Version: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
                appendLine("Redaction: active (pairing codes, TLS pins, Wi-Fi PSKs, tokens, MACs, and home paths scrubbed)")
                append(json.toJsonString())
            },
        )
    }

    fun copyDiagnosticsToClipboard(context: Context, extraState: AirBridgeAppUiState? = null): String {
        val report = formatShareableReport(context, extraState)
        runCatching {
            ConnectionService.markOwnClipboardWrite(report)
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.setPrimaryClip(ClipData.newPlainText("AirBridge Diagnostics", report))
        }
        return report
    }

    fun shareDiagnosticsReport(context: Context, extraState: AirBridgeAppUiState? = null) {
        val report = formatShareableReport(context, extraState)
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "AirBridge Android Diagnostic Report (${BuildConfig.VERSION_NAME})")
            putExtra(Intent.EXTRA_TEXT, report)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val chooser = Intent.createChooser(sendIntent, "Share AirBridge diagnostic report").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { context.startActivity(chooser) }
    }
}
