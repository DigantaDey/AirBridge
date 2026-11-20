package com.airbridge.app

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Color
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.Surface
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.airbridge.app.ui.theme.AirBridgeTheme
import com.airbridge.app.ui.theme.isResolvedDarkTheme
import com.airbridge.engine.Continuity
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Streams the phone screen to the paired computer that asked for it.
 *
 * MediaProjection → VirtualDisplay → MediaCodec AVC encoder → the engine's
 * [com.airbridge.engine.ContinuityChannel], which seals each access unit with
 * the session key (AES-256-GCM, header bound as AAD) and applies credit-based
 * flow control. Optionally, and only after a fresh session checkbox and Android
 * RECORD_AUDIO permission, Android 10+ Playback Capture yields a timestamped
 * PCM app-audio stream. Android and each source app remain authoritative: no
 * audio is requested from protected/opted-out apps, and AirBridge never tries
 * a second capture path. Nothing is captured until the user allowed it in
 * AirBridge and in Android's own capture prompt.
 */
class ScreenShareService : Service() {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var videoEncoder: MediaCodec? = null
    private var encoderSurface: Surface? = null
    private var audioRecord: AudioRecord? = null
    private var audioThread: HandlerThread? = null
    private var audioHandler: Handler? = null
    private var audioBuffer: ByteArray? = null
    private var playbackAudioRequested = false
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    @Volatile private var sessionId: String? = null
    private var maxEdge = Continuity.SCREEN_DEFAULT_MAX_WIDTH
    private var maxFps = Continuity.SCREEN_DEFAULT_FPS
    private var width = 0
    private var height = 0
    private var densityDpi = 0
    private var lastVideoBitrate = 0
    @Volatile private var cachedCodecConfig: ByteArray? = null
    @Volatile private var firstPtsUs: Long? = null
    @Volatile private var awaitingKeyframe = true
    @Volatile private var lastSyncRequestAt = 0L
    private var stopping = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start(intent)
            ACTION_DECLINE -> {
                val id = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
                ContinuityNotifications.cancel(this, ContinuityNotifications.screenRequestId(id))
                NativeEngineHost.instance?.continuityChannel()?.declineScreenShare(id, "Declined on the phone")
                if (sessionId == null) stopSelf(startId)
            }
            ACTION_STOP -> {
                val id = intent.getStringExtra(EXTRA_SESSION_ID)
                if (id == null || id == sessionId) finish("Sharing stopped on the phone")
            }
            ACTION_ENDED -> {
                val id = intent.getStringExtra(EXTRA_SESSION_ID)
                if (id != null && id == sessionId) finish(null)
                else if (sessionId == null) stopSelf(startId)
            }
            else -> if (sessionId == null) stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    private fun start(intent: Intent) {
        val id = intent.getStringExtra(EXTRA_SESSION_ID)
        // Never persisted: audio needs a deliberate choice for every session.
        val hasAudioPerm = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        AndroidDiagnostics.screenShareAudioPermissionGranted = hasAudioPerm
        playbackAudioRequested = intent.getBooleanExtra(EXTRA_SHARE_AUDIO, false) &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            hasAudioPerm
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_RESULT_DATA)
        // Android 14+: the mediaProjection foreground service must be running
        // before getMediaProjection() is called.
        val notification = buildNotification(id ?: "", NativeEngineHost.instance?.continuityChannel()?.screenRequest(id ?: "")?.peerName)
        val promoted = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                if (playbackAudioRequested && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                }
                startForeground(NOTIFICATION_ID, notification, types)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        }.onFailure {
            Log.w(TAG, "startForeground failed: ${it.message}")
            AndroidDiagnostics.recordEvent("screenShare", "startForeground failed: ${it.message}", "WARN")
        }.isSuccess
        val channel = NativeEngineHost.instance?.continuityChannel()
        if (id == null || data == null || resultCode != Activity.RESULT_OK || channel == null || !promoted || sessionId != null) {
            val reason = if (sessionId != null) "The phone is already sharing its screen" else "Screen capture was not allowed"
            id?.let { channel?.declineScreenShare(it, reason) }
            if (sessionId == null) stopEverything()
            return
        }
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val mp = runCatching { mpm?.getMediaProjection(resultCode, data) }.getOrNull()
        if (mp == null) {
            channel.declineScreenShare(id, "Screen capture is unavailable")
            stopEverything()
            return
        }
        val request = channel.acceptScreenShare(id)
        if (request == null) { // timed out or cancelled while the user decided
            mp.stop()
            stopEverything()
            return
        }
        sessionId = id
        activeSessionId = id
        activeInstance = this
        cachedCodecConfig = null
        firstPtsUs = null
        awaitingKeyframe = true
        lastSyncRequestAt = 0L
        AndroidDiagnostics.screenShareActive = true
        AndroidDiagnostics.recordEvent("screenShare", "Screen share session started (audioRequested=$playbackAudioRequested)")
        maxEdge = request.maxWidth
        maxFps = request.maxFps.coerceIn(1, Continuity.SCREEN_MAX_FPS)
        projection = mp
        val t = HandlerThread("airbridge-screen").also { it.start() }
        thread = t
        handler = Handler(t.looper)
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                handler?.post { finish("Sharing stopped on the phone") }
            }

            override fun onCapturedContentResize(width: Int, height: Int) {
                handler?.post { configure(width, height) }
            }
        }, handler)
        handler?.post { configure(null, null) }
        if (playbackAudioRequested) {
            startPlaybackAudio(id, mp)
        } else {
            AndroidDiagnostics.screenShareAudioAvailable = false
            AndroidDiagnostics.screenShareAudioRecordState = "disabled"
            channel.setScreenAudioAvailable(id, false)
        }
        ContinuityNotifications.cancel(this, ContinuityNotifications.screenRequestId(id))
    }

    /**
     * (Re)creates a hardware AVC encoder and makes MediaProjection render into
     * its input surface. This replaces the former RGBA → Bitmap → JPEG loop:
     * no screen image is serialised before encrypted transport.
     */
    private fun configure(contentWidth: Int?, contentHeight: Int?) {
        val mp = projection ?: return
        val (w0, h0, dpi) = screenSize()
        val srcW = contentWidth?.takeIf { it > 0 } ?: w0
        val srcH = contentHeight?.takeIf { it > 0 } ?: h0
        val scale = minOf(1.0, maxEdge.toDouble() / max(srcW, srcH))
        val w = ((srcW * scale).roundToInt() / 2 * 2).coerceAtLeast(2)
        val h = ((srcH * scale).roundToInt() / 2 * 2).coerceAtLeast(2)
        if (w == width && h == height && display != null && videoEncoder != null) return
        val next = runCatching { createVideoEncoder(w, h) }.onFailure { Log.w(TAG, "AVC encoder setup failed", it) }.getOrNull()
        if (next == null) {
            finish("Low-latency video encoding is unavailable on this phone")
            return
        }
        val nextSurface = runCatching { next.createInputSurface() }.onFailure { Log.w(TAG, "AVC input surface failed", it) }.getOrNull()
        if (nextSurface == null) {
            runCatching { next.release() }
            finish("Low-latency video encoding is unavailable on this phone")
            return
        }
        if (runCatching { next.setCallback(videoCallback, handler) }.onFailure { Log.w(TAG, "AVC callback setup failed", it) }.isFailure) {
            runCatching { nextSurface.release() }; runCatching { next.release() }
            finish("Low-latency video encoding is unavailable on this phone")
            return
        }
        if (runCatching { next.start() }.isFailure) {
            runCatching { nextSurface.release() }; runCatching { next.release() }
            finish("Low-latency video encoding could not start")
            return
        }
        val oldEncoder = videoEncoder
        val oldSurface = encoderSurface
        width = w
        height = h
        densityDpi = dpi
        videoEncoder = next
        encoderSurface = nextSurface
        lastVideoBitrate = sessionId?.let { id ->
            NativeEngineHost.instance?.continuityChannel()?.screenQuality(id)
        }?.let { Continuity.screenVideoBitrate(w, h, maxFps, it) } ?: Continuity.screenVideoBitrate(w, h, maxFps, 70)
        val vd = display
        if (vd == null) {
            display = runCatching {
                mp.createVirtualDisplay(
                    "AirBridge screen", w, h, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    nextSurface, null, handler,
                )
            }.onFailure { Log.w(TAG, "createVirtualDisplay failed", it) }.getOrNull()
            if (display == null) {
                releaseVideoEncoder(next, nextSurface)
                videoEncoder = null; encoderSurface = null
                finish("Screen capture failed on the phone")
                return
            }
        } else {
            vd.resize(w, h, dpi)
            vd.surface = nextSurface
        }
        releaseVideoEncoder(oldEncoder, oldSurface)
    }

    private fun createVideoEncoder(w: Int, h: Int): MediaCodec {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, android.media.MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            val quality = sessionId?.let { id -> NativeEngineHost.instance?.continuityChannel()?.screenQuality(id) } ?: 70
            setInteger(MediaFormat.KEY_BIT_RATE, Continuity.screenVideoBitrate(w, h, maxFps, quality))
            setInteger(MediaFormat.KEY_FRAME_RATE, maxFps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            // Keep video flowing even on a static screen and eliminate B-frame reordering latency.
            runCatching { setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000L) }
            runCatching { setInteger(MediaFormat.KEY_PRIORITY, 0) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1)
                runCatching { setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0) }
            }
        }
        return MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply { configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE) }
    }

    private fun requestSyncFrameInternal(force: Boolean) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastSyncRequestAt < 300L) return
        val codec = videoEncoder ?: return
        lastSyncRequestAt = now
        val targetHandler = handler
        val params = Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }
        if (targetHandler != null && targetHandler.looper !== android.os.Looper.myLooper()) {
            targetHandler.post { runCatching { videoEncoder?.setParameters(params) } }
        } else {
            runCatching { codec.setParameters(params) }
        }
    }

    internal fun requestSyncFrameFromRemote(reason: String?) {
        AndroidDiagnostics.recordScreenPliReceived()
        awaitingKeyframe = true
        requestSyncFrameInternal(force = true)
        if (!reason.isNullOrBlank()) {
            Log.d(TAG, "Keyframe requested by viewer: $reason")
        }
    }

    private val videoCallback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) = Unit // surface input
        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) = Unit
        override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) {
            if (codec === videoEncoder) handler?.post { finish("Low-latency video encoding failed") }
        }
        override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            try {
                if (codec !== videoEncoder || info.size <= 0) return
                val id = sessionId ?: return
                val rawBytes = codec.getOutputBuffer(index)?.let { buffer ->
                    buffer.position(info.offset); buffer.limit(info.offset + info.size)
                    ByteArray(info.size).also { buffer.get(it) }
                } ?: return
                if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                    cachedCodecConfig = rawBytes
                    AndroidDiagnostics.recordScreenCodecConfigCached()
                    return
                }
                val keyFrame = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                val anchor = firstPtsUs ?: info.presentationTimeUs.also { firstPtsUs = it }
                val ptsMs = ((info.presentationTimeUs - anchor) / 1000L).coerceAtLeast(0L) and 0xffffffffL
                val channel = NativeEngineHost.instance?.continuityChannel() ?: return
                val quality = channel.screenQuality(id)
                val targetBitrate = Continuity.screenVideoBitrate(width, height, maxFps, quality)
                if (kotlin.math.abs(targetBitrate - lastVideoBitrate) > 100_000) {
                    runCatching { codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, targetBitrate) }) }
                    lastVideoBitrate = targetBitrate
                }
                if (keyFrame) {
                    val payload = ensureAnnexBKeyFrameHeaders(rawBytes, cachedCodecConfig)
                    if (!channel.canSendScreenFrame(id, keyFrame = true, codec = Continuity.SCREEN_CODEC_H264)) return
                    if (channel.sendScreenVideoFrame(id, payload, width, height, ptsMs, true)) {
                        awaitingKeyframe = false
                        AndroidDiagnostics.recordScreenKeyFrameSent()
                    }
                    return
                }
                if (awaitingKeyframe || !channel.sendScreenVideoFrame(id, rawBytes, width, height, ptsMs, false)) {
                    awaitingKeyframe = true
                    AndroidDiagnostics.recordScreenFrameDropped()
                    requestSyncFrameInternal(force = false)
                }
            } catch (e: Exception) {
                Log.w(TAG, "AVC frame failed: ${e.message}")
            } finally {
                runCatching { codec.releaseOutputBuffer(index, false) }
            }
        }
    }

    private fun releaseVideoEncoder(codec: MediaCodec?, surface: Surface?) {
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        runCatching { surface?.release() }
    }

    private fun screenSize(): Triple<Int, Int, Int> {
        val wm = getSystemService(WindowManager::class.java)
        val dpi = resources.displayMetrics.densityDpi
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = wm.currentWindowMetrics.bounds
            Triple(b.width(), b.height(), dpi)
        } else {
            val m = android.util.DisplayMetrics()
            @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(m)
            Triple(m.widthPixels, m.heightPixels, dpi)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        handler?.post { configure(null, null) } // rotation: swap the capture size
    }

    /**
     * Starts Android Playback Capture only. The platform applies both user
     * profile and the source app's capture policy; this service neither names
     * apps nor attempts microphone/Accessibility/DRM workarounds.
     */
    private fun startPlaybackAudio(id: String, mp: MediaProjection) {
        val channel = NativeEngineHost.instance?.continuityChannel()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            AndroidDiagnostics.screenShareAudioAvailable = false
            AndroidDiagnostics.screenShareAudioRecordState = "unsupported_sdk"
            channel?.setScreenAudioAvailable(id, false)
            return
        }
        val hasAudioPerm = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        AndroidDiagnostics.screenShareAudioPermissionGranted = hasAudioPerm
        if (!hasAudioPerm) {
            AndroidDiagnostics.screenShareAudioAvailable = false
            AndroidDiagnostics.screenShareAudioRecordState = "permission_denied"
            AndroidDiagnostics.recordEvent("screenShare", "RECORD_AUDIO permission missing for playback capture", "WARN")
            channel?.setScreenAudioAvailable(id, false)
            return
        }
        val sampleRate = 48_000
        val channelMask = AudioFormat.CHANNEL_IN_STEREO
        val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
        val bytesPerTwentyMs = sampleRate / 50 * 2 * 2
        if (minBuffer <= 0) {
            AndroidDiagnostics.screenShareAudioAvailable = false
            AndroidDiagnostics.screenShareAudioRecordState = "invalid_buffer_size"
            channel?.setScreenAudioAvailable(id, false)
            return
        }
        val capture: AudioRecord? = try {
            val config = AudioPlaybackCaptureConfiguration.Builder(mp)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .build()
            AudioRecord.Builder()
                .setAudioPlaybackCaptureConfig(config)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .build(),
                )
                .setBufferSizeInBytes(maxOf(minBuffer, bytesPerTwentyMs * 2))
                .build()
        } catch (se: SecurityException) {
            Log.w(TAG, "Playback capture blocked by SecurityException: ${se.message}")
            AndroidDiagnostics.screenShareAudioAvailable = false
            AndroidDiagnostics.screenShareAudioRecordState = "security_exception"
            AndroidDiagnostics.recordEvent("screenShare", "Playback capture SecurityException: ${se.message}", "WARN")
            channel?.setScreenAudioAvailable(id, false)
            null
        } catch (e: Exception) {
            Log.i(TAG, "Playback capture is unavailable: ${e.message}")
            AndroidDiagnostics.screenShareAudioAvailable = false
            AndroidDiagnostics.screenShareAudioRecordState = "init_failed"
            channel?.setScreenAudioAvailable(id, false)
            null
        }
        if (capture == null || capture.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { capture?.release() }
            AndroidDiagnostics.screenShareAudioAvailable = false
            if (capture != null) AndroidDiagnostics.screenShareAudioRecordState = "uninitialized"
            channel?.setScreenAudioAvailable(id, false)
            return
        }
        val buffer = ByteArray(bytesPerTwentyMs)
        val t = HandlerThread("airbridge-playback-audio").also { it.start() }
        audioRecord = capture
        audioBuffer = buffer
        audioThread = t
        audioHandler = Handler(t.looper)
        val started = try {
            capture.startRecording()
            true
        } catch (se: SecurityException) {
            Log.w(TAG, "Playback capture startRecording SecurityException: ${se.message}")
            AndroidDiagnostics.screenShareAudioRecordState = "start_security_exception"
            AndroidDiagnostics.recordEvent("screenShare", "startRecording SecurityException: ${se.message}", "WARN")
            false
        } catch (e: Exception) {
            Log.i(TAG, "Playback capture could not start: ${e.message}")
            AndroidDiagnostics.screenShareAudioRecordState = "start_failed"
            false
        }
        if (!started) {
            stopPlaybackAudio()
            channel?.setScreenAudioAvailable(id, false)
            return
        }
        AndroidDiagnostics.screenShareAudioAvailable = true
        AndroidDiagnostics.screenShareAudioRecordState = "recording"
        channel?.setScreenAudioAvailable(id, true)
        audioHandler?.post(audioPump)
    }

    private val audioPump = object : Runnable {
        override fun run() {
            val id = sessionId ?: return
            val record = audioRecord ?: return
            val bytes = audioBuffer ?: return
            val read = runCatching {
                record.read(bytes, 0, bytes.size, AudioRecord.READ_BLOCKING)
            }.getOrDefault(0)
            val validBytes = read - (read.coerceAtLeast(0) % 4) // 16-bit stereo samples
            if (validBytes > 0) {
                val timestamp = SystemClock.elapsedRealtime() and 0xffffffffL
                NativeEngineHost.instance?.continuityChannel()?.sendScreenAudio(
                    id, if (validBytes == bytes.size) bytes else bytes.copyOf(validBytes),
                    48_000, 2, validBytes / 4, timestamp,
                )
            }
            if (!stopping && sessionId == id && audioRecord === record) audioHandler?.post(this)
        }
    }

    private fun stopPlaybackAudio() {
        val id = sessionId
        id?.let { NativeEngineHost.instance?.continuityChannel()?.setScreenAudioAvailable(it, false) }
        AndroidDiagnostics.screenShareAudioAvailable = false
        val record = audioRecord
        audioRecord = null
        audioBuffer = null
        runCatching { record?.stop() }
        runCatching { record?.release() }
        audioHandler?.removeCallbacksAndMessages(null)
        audioHandler = null
        audioThread?.quitSafely()
        audioThread = null
    }

    /** [reason] null = the computer ended it (or disconnected); otherwise tell it why. */
    private fun finish(reason: String?) {
        if (stopping) return
        stopping = true
        val id = sessionId
        sessionId = null
        activeSessionId = null
        AndroidDiagnostics.screenShareActive = false
        AndroidDiagnostics.screenShareAudioRecordState = "idle"
        if (id != null && reason != null) NativeEngineHost.instance?.continuityChannel()?.stopScreenShare(id, reason)
        stopEverything()
    }

    private fun stopEverything() {
        if (activeInstance === this) activeInstance = null
        cachedCodecConfig = null
        firstPtsUs = null
        stopPlaybackAudio()
        runCatching { display?.release() }
        display = null
        releaseVideoEncoder(videoEncoder, encoderSurface)
        videoEncoder = null
        encoderSurface = null
        runCatching { projection?.stop() }
        projection = null
        thread?.quitSafely()
        thread = null
        handler = null
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }

    override fun onDestroy() {
        if (!stopping) finish("Sharing stopped on the phone")
        super.onDestroy()
    }

    private fun buildNotification(id: String, peerName: String?): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm?.getNotificationChannel(CHANNEL_ID) == null) {
            nm?.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while your screen is shared with a computer"
                },
            )
        }
        val stop = PendingIntent.getService(
            this, 0,
            Intent(this, ScreenShareService::class.java).setPackage(packageName).setAction(ACTION_STOP).putExtra(EXTRA_SESSION_ID, id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Sharing your screen" + (peerName?.let { " with $it" } ?: ""))
            .setContentText(if (playbackAudioRequested) "Screen and permitted app audio are being shared. Stop at any time." else "Your screen is being shared. App audio is off.")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, "Stop sharing", stop).build())
            .build()
    }

    companion object {
        private const val TAG = "AirBridgeScreen"
        private const val CHANNEL_ID = "airbridge_screen_share"
        private const val NOTIFICATION_ID = 0x5C2EE
        const val ACTION_START = "com.airbridge.app.SCREEN_START"
        const val ACTION_STOP = "com.airbridge.app.SCREEN_STOP"
        const val ACTION_DECLINE = "com.airbridge.app.SCREEN_DECLINE"
        const val ACTION_ENDED = "com.airbridge.app.SCREEN_ENDED"
        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_SHARE_AUDIO = "shareAudio"

        /** Session currently being captured (null = not sharing). */
        @Volatile var activeSessionId: String? = null
            private set
        @Volatile private var activeInstance: ScreenShareService? = null

        fun requestKeyFrame(sessionId: String, reason: String? = null) {
            activeInstance?.let { svc ->
                if (svc.sessionId == sessionId) {
                    svc.requestSyncFrameFromRemote(reason)
                }
            }
        }

        /**
         * Ensures an H.264 sync access unit carries Annex-B SPS (NAL type 7) and PPS
         * (NAL type 8) parameter sets so hardware/WebKit decoders (including macOS
         * WKWebView WebCodecs) can initialize cleanly on mid-stream joins or recovery.
         */
        internal fun ensureAnnexBKeyFrameHeaders(accessUnit: ByteArray, codecConfig: ByteArray?): ByteArray {
            if (codecConfig == null || codecConfig.isEmpty()) return accessUnit
            var hasSps = false
            var hasPps = false
            var i = 0
            while (i + 3 <= accessUnit.size) {
                val startLen = when {
                    i + 3 < accessUnit.size &&
                        accessUnit[i] == 0.toByte() &&
                        accessUnit[i + 1] == 0.toByte() &&
                        accessUnit[i + 2] == 0.toByte() &&
                        accessUnit[i + 3] == 1.toByte() -> 4
                    accessUnit[i] == 0.toByte() &&
                        accessUnit[i + 1] == 0.toByte() &&
                        accessUnit[i + 2] == 1.toByte() -> 3
                    else -> 0
                }
                if (startLen > 0) {
                    val nalIdx = i + startLen
                    if (nalIdx < accessUnit.size) {
                        val nalType = accessUnit[nalIdx].toInt() and 0x1f
                        if (nalType == 7) hasSps = true
                        if (nalType == 8) hasPps = true
                        if (hasSps && hasPps) return accessUnit
                    }
                    i += startLen
                } else {
                    i += 1
                }
            }
            val needsStart = accessUnit.size < 3 ||
                !(
                    (accessUnit[0] == 0.toByte() && accessUnit[1] == 0.toByte() && accessUnit[2] == 1.toByte()) ||
                        (accessUnit.size >= 4 && accessUnit[0] == 0.toByte() && accessUnit[1] == 0.toByte() && accessUnit[2] == 0.toByte() && accessUnit[3] == 1.toByte())
                    )
            val pad = if (needsStart) 4 else 0
            val combined = ByteArray(codecConfig.size + pad + accessUnit.size)
            System.arraycopy(codecConfig, 0, combined, 0, codecConfig.size)
            if (needsStart) {
                combined[codecConfig.size] = 0
                combined[codecConfig.size + 1] = 0
                combined[codecConfig.size + 2] = 0
                combined[codecConfig.size + 3] = 1
            }
            System.arraycopy(accessUnit, 0, combined, codecConfig.size + pad, accessUnit.size)
            return combined
        }

        /** The computer stopped viewing or disconnected. */
        fun stopSession(context: Context, sessionId: String) {
            if (activeSessionId != sessionId) return
            runCatching {
                context.startService(
                    Intent(context, ScreenShareService::class.java)
                        .setPackage(context.packageName)
                        .setAction(ACTION_ENDED)
                        .putExtra(EXTRA_SESSION_ID, sessionId),
                )
            } // not running (background start refused) = nothing to stop
        }
    }
}

/**
 * Jetpack Compose Material 3 consent step for a computer's screen-share request:
 * AirBridge explains what will be visible, handles the 3-state RECORD_AUDIO
 * permission flow (granted -> rationale -> contract -> Settings redirect or
 * video-only continuation), and launches Android's own MediaProjection prompt.
 */
class ScreenShareConsentActivity : ComponentActivity() {
    private var sessionId by mutableStateOf("")
    private var peerName by mutableStateOf("")
    private var decided = false
    private var requestedAudio = false
    private var showAudioRationaleDialog by mutableStateOf(false)
    private var showAudioSettingsDialog by mutableStateOf(false)

    private val projectionCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode != RESULT_OK || data == null) {
            decline("Screen capture was not allowed")
            return@registerForActivityResult
        }
        decided = true
        val start = Intent(this, ScreenShareService::class.java)
            .setPackage(packageName)
            .setAction(ScreenShareService.ACTION_START)
            .putExtra(ScreenShareService.EXTRA_SESSION_ID, sessionId)
            .putExtra(ScreenShareService.EXTRA_RESULT_CODE, result.resultCode)
            .putExtra(ScreenShareService.EXTRA_RESULT_DATA, data)
            .putExtra(ScreenShareService.EXTRA_SHARE_AUDIO, requestedAudio)
        runCatching { startForegroundService(start) }
            .onFailure { decline("Could not start screen sharing") }
        finish()
    }

    private val audioPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { isGranted ->
        AndroidDiagnostics.screenShareAudioPermissionGranted = isGranted
        if (isGranted) {
            requestedAudio = true
            launchProjectionCapture()
        } else {
            val permanentlyDenied = !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
            if (permanentlyDenied) {
                showAudioSettingsDialog = true
            } else {
                requestedAudio = false
                runCatching {
                    Toast.makeText(
                        this,
                        getString(R.string.screen_share_audio_denied_toast),
                        Toast.LENGTH_LONG,
                    ).show()
                }
                launchProjectionCapture()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val prefs = Prefs(this)
        val dark = prefs.themeMode != "light"
        val barStyle = if (dark) {
            SystemBarStyle.dark(Color.TRANSPARENT)
        } else {
            SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        }
        enableEdgeToEdge(statusBarStyle = barStyle, navigationBarStyle = barStyle)
        super.onCreate(savedInstanceState)

        if (!bindIncomingIntent(intent)) return

        setContent {
            val themeMode = prefs.themeMode
            val isDark = isResolvedDarkTheme(themeMode)
            val audioSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            var shareAudioChecked by rememberSaveable(sessionId) { mutableStateOf(false) }

            AirBridgeTheme(themeMode = if (isDark) "dark" else "light") {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .safeDrawingPadding(),
                ) {
                    if (showAudioRationaleDialog) {
                        AlertDialog(
                            onDismissRequest = {
                                showAudioRationaleDialog = false
                                requestedAudio = false
                                launchProjectionCapture()
                            },
                            title = { Text(stringResource(R.string.screen_share_audio_rationale_title)) },
                            text = { Text(stringResource(R.string.screen_share_audio_rationale_body)) },
                            confirmButton = {
                                Button(
                                    onClick = {
                                        showAudioRationaleDialog = false
                                        audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                    },
                                ) {
                                    Text(stringResource(R.string.screen_share_continue))
                                }
                            },
                            dismissButton = {
                                TextButton(
                                    onClick = {
                                        showAudioRationaleDialog = false
                                        requestedAudio = false
                                        launchProjectionCapture()
                                    },
                                ) {
                                    Text(stringResource(R.string.screen_share_audio_continue_video_only))
                                }
                            },
                        )
                    } else if (showAudioSettingsDialog) {
                        AlertDialog(
                            onDismissRequest = {
                                showAudioSettingsDialog = false
                                requestedAudio = false
                                launchProjectionCapture()
                            },
                            title = { Text(stringResource(R.string.screen_share_audio_settings_title)) },
                            text = { Text(stringResource(R.string.screen_share_audio_settings_body)) },
                            confirmButton = {
                                Button(
                                    onClick = {
                                        showAudioSettingsDialog = false
                                        openAppDetailsSettings()
                                    },
                                ) {
                                    Text(stringResource(R.string.screen_share_open_settings))
                                }
                            },
                            dismissButton = {
                                TextButton(
                                    onClick = {
                                        showAudioSettingsDialog = false
                                        requestedAudio = false
                                        launchProjectionCapture()
                                    },
                                ) {
                                    Text(stringResource(R.string.screen_share_audio_continue_video_only))
                                }
                            },
                        )
                    } else if (peerName.isNotBlank()) {
                        AlertDialog(
                            onDismissRequest = { decline("Declined on the phone") },
                            title = {
                                Text(
                                    text = stringResource(R.string.screen_share_consent_title, peerName),
                                    style = MaterialTheme.typography.titleLarge,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            },
                            text = {
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .verticalScroll(rememberScrollState()),
                                    verticalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    Text(
                                        text = stringResource(R.string.screen_share_consent_body, peerName),
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .minimumInteractiveComponentSize()
                                            .clickable(
                                                enabled = audioSupported,
                                                role = Role.Checkbox,
                                            ) {
                                                shareAudioChecked = !shareAudioChecked
                                            }
                                            .padding(vertical = 4.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Checkbox(
                                            checked = shareAudioChecked && audioSupported,
                                            onCheckedChange = null,
                                            enabled = audioSupported,
                                        )
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text(
                                            text = if (audioSupported) {
                                                stringResource(R.string.screen_share_audio_checkbox)
                                            } else {
                                                stringResource(R.string.screen_share_audio_unsupported)
                                            },
                                            style = MaterialTheme.typography.bodySmall,
                                        )
                                    }
                                }
                            },
                            confirmButton = {
                                Button(
                                    onClick = { beginCapture(shareAudioChecked && audioSupported) },
                                ) {
                                    Text(stringResource(R.string.screen_share_continue))
                                }
                            },
                            dismissButton = {
                                OutlinedButton(
                                    onClick = { decline("Declined on the phone") },
                                ) {
                                    Text(stringResource(R.string.screen_share_decline))
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        decided = false
        requestedAudio = false
        showAudioRationaleDialog = false
        showAudioSettingsDialog = false
        bindIncomingIntent(intent)
    }

    private fun bindIncomingIntent(incoming: Intent?): Boolean {
        val nextId = incoming?.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        sessionId = nextId
        val channel = NativeEngineHost.instance?.continuityChannel()
        val request = channel?.screenRequest(nextId)
        if (request == null) {
            runCatching { Toast.makeText(this, getString(R.string.screen_share_expired), Toast.LENGTH_SHORT).show() }
            finish()
            return false
        }
        if (!Prefs(this).screenSharing) {
            channel.declineScreenShare(nextId, "Screen sharing is disabled on the phone")
            ContinuityNotifications.cancel(this, ContinuityNotifications.screenRequestId(nextId))
            runCatching { Toast.makeText(this, getString(R.string.screen_share_disabled_toast), Toast.LENGTH_SHORT).show() }
            finish()
            return false
        }
        peerName = request.peerName
        return true
    }

    private fun beginCapture(withAudio: Boolean) {
        requestedAudio = withAudio
        if (!withAudio) {
            launchProjectionCapture()
            return
        }
        val permission = Manifest.permission.RECORD_AUDIO
        when {
            ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED -> {
                AndroidDiagnostics.screenShareAudioPermissionGranted = true
                launchProjectionCapture()
            }
            shouldShowRequestPermissionRationale(permission) -> {
                showAudioRationaleDialog = true
            }
            else -> {
                audioPermissionLauncher.launch(permission)
            }
        }
    }

    private fun launchProjectionCapture() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        if (mpm == null) {
            decline("Screen capture is unavailable")
        } else {
            runCatching {
                projectionCaptureLauncher.launch(mpm.createScreenCaptureIntent())
            }.onFailure {
                decline("Screen capture is unavailable")
            }
        }
    }

    private fun openAppDetailsSettings() {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", packageName, null)
        }
        runCatching { startActivity(intent) }
    }

    private fun decline(reason: String) {
        if (decided) return
        decided = true
        NativeEngineHost.instance?.continuityChannel()?.declineScreenShare(sessionId, reason)
        ContinuityNotifications.cancel(this, ContinuityNotifications.screenRequestId(sessionId))
        finish()
    }

    companion object {
        const val EXTRA_SESSION_ID = "sessionId"
    }
}
