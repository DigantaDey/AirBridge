package com.airbridge.app

import android.app.Activity
import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaFormat
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioPlaybackCaptureConfiguration
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import android.view.WindowManager
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
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
        playbackAudioRequested = intent.getBooleanExtra(EXTRA_SHARE_AUDIO, false) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_RESULT_DATA)
        // Android 14+: the mediaProjection foreground service must be running
        // before getMediaProjection() is called.
        val notification = buildNotification(id ?: "", NativeEngineHost.instance?.continuityChannel()?.screenRequest(id ?: "")?.peerName)
        val promoted = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                if (playbackAudioRequested) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                startForeground(NOTIFICATION_ID, notification, types)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        }.onFailure { Log.w(TAG, "startForeground failed: ${it.message}") }.isSuccess
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
        if (playbackAudioRequested) startPlaybackAudio(id, mp) else channel.setScreenAudioAvailable(id, false)
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
        lastVideoBitrate = 0
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
            setInteger(MediaFormat.KEY_BIT_RATE, (w * h * 4).coerceIn(750_000, 8_000_000))
            setInteger(MediaFormat.KEY_FRAME_RATE, maxFps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            // WebCodecs consumes Annex-B AVC without an external config blob.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1)
        }
        return MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply { configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE) }
    }

    private val videoCallback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) = Unit // surface input
        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) = Unit
        override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) {
            if (codec === videoEncoder) handler?.post { finish("Low-latency video encoding failed") }
        }
        override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            try {
                if (codec !== videoEncoder || info.size <= 0 || (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) return
                val id = sessionId ?: return
                val bytes = codec.getOutputBuffer(index)?.let { buffer ->
                    buffer.position(info.offset); buffer.limit(info.offset + info.size)
                    ByteArray(info.size).also { buffer.get(it) }
                } ?: return
                val keyFrame = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                // Use the same elapsed-realtime clock as AudioRecord packets;
                // the decoded access unit is already in source order.
                val ptsMs = SystemClock.elapsedRealtime() and 0xffffffffL
                val channel = NativeEngineHost.instance?.continuityChannel() ?: return
                // Encoder bitrate tracks the existing relay RTT controller. Access
                // units that cannot get flow-control credit are dropped, never queued.
                val quality = channel.screenQuality(id)
                val targetBitrate = (width * height * (2 + quality * 4)).toInt().coerceIn(500_000, 8_000_000)
                if (kotlin.math.abs(targetBitrate - lastVideoBitrate) > 150_000 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                    runCatching { codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, targetBitrate) }) }
                    lastVideoBitrate = targetBitrate
                }
                channel.sendScreenVideoFrame(id, bytes, width, height, ptsMs, keyFrame)
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val sampleRate = 48_000
        val channelMask = AudioFormat.CHANNEL_IN_STEREO
        val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
        val bytesPerTwentyMs = sampleRate / 50 * 2 * 2
        if (minBuffer <= 0) return
        val capture = runCatching {
            val config = AudioPlaybackCaptureConfiguration.Builder(mp)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .build()
            AudioRecord.Builder()
                .setAudioPlaybackCaptureConfig(config)
                .setAudioFormat(AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(channelMask)
                    .build())
                .setBufferSizeInBytes(maxOf(minBuffer, bytesPerTwentyMs * 2))
                .build()
        }.onFailure { Log.i(TAG, "Playback capture is unavailable: ${it.message}") }.getOrNull()
        if (capture == null || capture.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { capture?.release() }
            return
        }
        val buffer = ByteArray(bytesPerTwentyMs)
        val t = HandlerThread("airbridge-playback-audio").also { it.start() }
        audioRecord = capture
        audioBuffer = buffer
        audioThread = t
        audioHandler = Handler(t.looper)
        val started = runCatching { capture.startRecording() }.onFailure {
            Log.i(TAG, "Playback capture could not start: ${it.message}")
        }.isSuccess
        if (!started) {
            stopPlaybackAudio()
            return
        }
        NativeEngineHost.instance?.continuityChannel()?.setScreenAudioAvailable(id, true)
        audioHandler?.post(audioPump)
    }

    private val audioPump = object : Runnable {
        override fun run() {
            val id = sessionId ?: return
            val record = audioRecord ?: return
            val bytes = audioBuffer ?: return
            val read = runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) record.read(bytes, 0, bytes.size, AudioRecord.READ_BLOCKING)
                else @Suppress("DEPRECATION") record.read(bytes, 0, bytes.size)
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
        if (id != null && reason != null) NativeEngineHost.instance?.continuityChannel()?.stopScreenShare(id, reason)
        stopEverything()
    }

    private fun stopEverything() {
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
 * Consent step for a computer's screen-share request: AirBridge explains what
 * will be visible, then Android's own capture prompt follows. Declining (or
 * backing out of either dialog) tells the computer immediately.
 */
class ScreenShareConsentActivity : Activity() {
    private var sessionId: String = ""
    private var decided = false
    private var requestedAudio = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionId = intent?.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        val channel = NativeEngineHost.instance?.continuityChannel()
        val request = channel?.screenRequest(sessionId)
        if (request == null) {
            runCatching { Toast.makeText(this, "That screen-sharing request has expired", Toast.LENGTH_SHORT).show() }
            finish()
            return
        }
        if (!Prefs(this).screenSharing) {
            channel.declineScreenShare(sessionId, "Screen sharing is disabled on the phone")
            ContinuityNotifications.cancel(this, ContinuityNotifications.screenRequestId(sessionId))
            runCatching { Toast.makeText(this, "Enable Screen sharing in AirBridge settings first", Toast.LENGTH_SHORT).show() }
            finish()
            return
        }
        if (savedInstanceState?.getBoolean(STATE_ASKED) == true) return
        val box = CheckBox(this).apply {
            text = "Also share permitted app audio"
            isChecked = false // fresh, explicit, default-off consent every session
            isEnabled = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            if (!isEnabled) text = "App audio requires Android 10 or later"
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (20 * resources.displayMetrics.density).toInt()
            setPadding(padding, 0, padding, 0)
            addView(TextView(this@ScreenShareConsentActivity).apply {
                text = "${request.peerName} will see everything on this phone's screen, including notifications, until you stop sharing. " +
                    "App audio is off unless you select it below. Android and the source app decide whether playback capture is allowed; " +
                    "protected or opted-out content is not shared and may be blank or silent. The stream is end-to-end encrypted and never leaves your devices."
            })
            addView(box)
        }
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Share your screen with ${request.peerName}?")
            .setView(content)
            .setPositiveButton("Continue") { _, _ -> beginCapture(box.isChecked && box.isEnabled) }
            .setNegativeButton("Decline") { _, _ -> decline("Declined on the phone") }
            .setOnCancelListener { decline("Declined on the phone") }
            .show()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_ASKED, true)
    }

    private fun beginCapture(withAudio: Boolean) {
        requestedAudio = withAudio
        if (withAudio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
            return
        }
        launchProjectionCapture()
    }

    private fun launchProjectionCapture() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        if (mpm == null) decline("Screen capture is unavailable")
        else {
            @Suppress("DEPRECATION")
            startActivityForResult(mpm.createScreenCaptureIntent(), REQUEST_CAPTURE)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_AUDIO) return
        if (grantResults.firstOrNull() != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            // Video consent remains valid; accurately report audio as unavailable rather than failing open.
            requestedAudio = false
            Toast.makeText(this, "App audio will not be shared without microphone permission", Toast.LENGTH_LONG).show()
        }
        launchProjectionCapture()
    }

    private fun decline(reason: String) {
        if (decided) return
        decided = true
        NativeEngineHost.instance?.continuityChannel()?.declineScreenShare(sessionId, reason)
        ContinuityNotifications.cancel(this, ContinuityNotifications.screenRequestId(sessionId))
        finish()
    }

    @Deprecated("Platform Activity result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CAPTURE) return
        if (resultCode != RESULT_OK || data == null) return decline("Screen capture was not allowed")
        decided = true
        val start = Intent(this, ScreenShareService::class.java)
            .setPackage(packageName)
            .setAction(ScreenShareService.ACTION_START)
            .putExtra(ScreenShareService.EXTRA_SESSION_ID, sessionId)
            .putExtra(ScreenShareService.EXTRA_RESULT_CODE, resultCode)
            .putExtra(ScreenShareService.EXTRA_RESULT_DATA, data)
            .putExtra(ScreenShareService.EXTRA_SHARE_AUDIO, requestedAudio)
        runCatching { startForegroundService(start) }
            .onFailure { decline("Could not start screen sharing") }
        finish()
    }

    companion object {
        const val EXTRA_SESSION_ID = "sessionId"
        private const val REQUEST_CAPTURE = 0x5C
        private const val REQUEST_AUDIO = 0x5D
        private const val STATE_ASKED = "asked"
    }
}
