package com.airbridge.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
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
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Log
import android.view.WindowManager
import android.widget.Toast
import com.airbridge.engine.Continuity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Streams the phone screen to the paired computer that asked for it.
 *
 * MediaProjection → VirtualDisplay → ImageReader (RGBA) → scaled JPEG → the
 * engine's [com.airbridge.engine.ContinuityChannel] which seals each frame with
 * the session key (AES-256-GCM, header bound as AAD) and applies credit-based
 * flow control: at most two unacknowledged frames, latest frame wins, JPEG
 * quality adapts to the measured round trip. Nothing is captured until the user
 * allowed it: in AirBridge (or by tapping "Cast to computer") and in Android's
 * own capture prompt.
 *
 * Sound (Android 10+): AudioPlaybackCapture of media/game audio — never the
 * microphone and never calls — as 48 kHz stereo PCM sealed per chunk. Apps can
 * opt out of capture, and DRM video (Netflix, Prime Video, Hotstar…) is drawn
 * black by Android; neither is worked around. A long all-black picture sends
 * the computer a short explanation instead.
 */
class ScreenShareService : Service() {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    @Volatile private var sessionId: String? = null
    private var maxEdge = Continuity.SCREEN_DEFAULT_MAX_WIDTH
    private var width = 0
    private var height = 0
    private var densityDpi = 0
    private var latest: Bitmap? = null
    private var dirty = false
    private var stopping = false
    private var audioRecord: AudioRecord? = null
    private var audioThread: Thread? = null
    @Volatile private var audioRunning = false
    private var blackChecks = 0
    private var blackNoticeShown = false

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
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_RESULT_DATA)
        // Android 14+: the mediaProjection foreground service must be running
        // before getMediaProjection() is called.
        val notification = buildNotification(id ?: "", NativeEngineHost.instance?.continuityChannel()?.screenRequest(id ?: "")?.peerName)
        val promoted = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
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
        // Sound needs Android 10+, RECORD_AUDIO and a projection; otherwise the
        // share runs silent and tells the computer so (state active, audio=false).
        val record = if (channel.screenRequest(id)?.audio == true) createAudioRecord(mp) else null
        val request = channel.acceptScreenShare(id, withAudio = record != null)
        if (request == null) { // timed out or cancelled while the user decided
            runCatching { record?.release() }
            mp.stop()
            stopEverything()
            return
        }
        sessionId = id
        activeSessionId = id
        maxEdge = request.maxWidth
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
        handler?.postDelayed(blackCheck, BLACK_CHECK_MS)
        if (record != null) startAudio(id, record)
        ContinuityNotifications.cancel(this, ContinuityNotifications.screenRequestId(id))
    }

    /** Playback capture of media and game audio (not the microphone, not calls). */
    private fun createAudioRecord(mp: MediaProjection): AudioRecord? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return null
        return runCatching {
            val config = AudioPlaybackCaptureConfiguration.Builder(mp)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(AUDIO_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build()
            val minBuffer = AudioRecord.getMinBufferSize(AUDIO_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
            val rec = AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(max(minBuffer, AUDIO_CHUNK_BYTES * 4))
                .setAudioPlaybackCaptureConfig(config)
                .build()
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                rec.release()
                null
            } else rec
        }.onFailure { Log.w(TAG, "Playback capture unavailable: ${it.message}") }.getOrNull()
    }

    private fun startAudio(id: String, rec: AudioRecord) {
        audioRecord = rec
        audioRunning = true
        audioThread = Thread({
            val buf = ByteArray(AUDIO_CHUNK_BYTES)
            try {
                rec.startRecording()
                while (audioRunning) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n < 0) break
                    val len = n - n % 4 // whole stereo s16 frames
                    if (len == 0) continue
                    val channel = NativeEngineHost.instance?.continuityChannel() ?: break
                    // Dropped when the socket is busy: late audio is worse than a gap.
                    channel.sendScreenAudio(id, buf.copyOf(len), AUDIO_RATE, 2)
                }
            } catch (e: Exception) {
                Log.w(TAG, "screen audio stopped: ${e.message}")
            }
        }, "airbridge-screen-audio").apply { isDaemon = true; start() }
    }

    private fun stopAudio() {
        audioRunning = false
        val rec = audioRecord
        audioRecord = null
        runCatching { rec?.stop() }
        runCatching { audioThread?.join(300) }
        audioThread = null
        runCatching { rec?.release() }
    }

    /**
     * Protected (DRM / FLAG_SECURE) content and a locked screen are captured as
     * black by Android. After a few seconds of an all-black picture, explain it
     * on the computer; clear the note when a picture returns.
     */
    private val blackCheck: Runnable = object : Runnable {
        override fun run() {
            val id = sessionId ?: return
            val bmp = latest
            if (bmp != null && !bmp.isRecycled) {
                val black = isNearlyBlack(bmp, minOf(width, bmp.width), minOf(height, bmp.height))
                blackChecks = if (black) blackChecks + 1 else 0
                val channel = NativeEngineHost.instance?.continuityChannel()
                if (black && blackChecks >= BLACK_CHECKS_BEFORE_NOTICE && !blackNoticeShown) {
                    blackNoticeShown = true
                    channel?.screenNotice(id, BLACK_NOTICE)
                } else if (!black && blackNoticeShown) {
                    blackNoticeShown = false
                    channel?.screenNotice(id, "")
                }
            }
            handler?.postDelayed(this, BLACK_CHECK_MS)
        }
    }

    private fun isNearlyBlack(bmp: Bitmap, w: Int, h: Int): Boolean {
        if (w <= 0 || h <= 0) return false
        for (gy in 1..12) for (gx in 1..12) {
            val p = bmp.getPixel(w * gx / 13, h * gy / 13)
            val r = (p shr 16) and 0xff
            val g = (p shr 8) and 0xff
            val b = p and 0xff
            if (r > 14 || g > 14 || b > 14) return false
        }
        return true
    }

    /** (Re)creates the capture surface for the current orientation / captured content size. */
    private fun configure(contentWidth: Int?, contentHeight: Int?) {
        val mp = projection ?: return
        val (w0, h0, dpi) = screenSize()
        val srcW = contentWidth?.takeIf { it > 0 } ?: w0
        val srcH = contentHeight?.takeIf { it > 0 } ?: h0
        val scale = minOf(1.0, maxEdge.toDouble() / max(srcW, srcH))
        val w = ((srcW * scale).roundToInt() / 2 * 2).coerceAtLeast(2)
        val h = ((srcH * scale).roundToInt() / 2 * 2).coerceAtLeast(2)
        if (w == width && h == height && display != null) return
        width = w
        height = h
        densityDpi = dpi
        val nextReader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        nextReader.setOnImageAvailableListener({ onImage(it) }, handler)
        val old = reader
        reader = nextReader
        latest?.recycle()
        latest = null
        val vd = display
        if (vd == null) {
            display = runCatching {
                mp.createVirtualDisplay(
                    "AirBridge screen", w, h, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    nextReader.surface, null, handler,
                )
            }.onFailure { Log.w(TAG, "createVirtualDisplay failed", it) }.getOrNull()
            if (display == null) {
                finish("Screen capture failed on the phone")
                return
            }
        } else {
            vd.resize(w, h, dpi)
            vd.surface = nextReader.surface
        }
        old?.close()
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

    private fun onImage(r: ImageReader) {
        val image = runCatching { r.acquireLatestImage() }.getOrNull() ?: return
        try {
            if (r !== reader) return
            val plane = image.planes[0]
            val pixelStride = plane.pixelStride
            val rowPadding = plane.rowStride - pixelStride * image.width
            val paddedWidth = image.width + rowPadding / pixelStride
            var bmp = latest
            if (bmp == null || bmp.width != paddedWidth || bmp.height != image.height) {
                bmp?.recycle()
                bmp = Bitmap.createBitmap(paddedWidth, image.height, Bitmap.Config.ARGB_8888)
                latest = bmp
            }
            plane.buffer.rewind()
            bmp!!.copyPixelsFromBuffer(plane.buffer)
            dirty = true
        } catch (e: Exception) {
            Log.w(TAG, "frame copy failed: ${e.message}")
        } finally {
            image.close()
        }
        pump()
    }

    /**
     * Sends the newest frame when the channel has credit. A dropped frame is
     * retried shortly so a static screen still converges on the latest image.
     */
    private fun pump() {
        val id = sessionId ?: return
        val h = handler ?: return
        if (!dirty) return
        val channel = NativeEngineHost.instance?.continuityChannel()
        if (channel == null || !channel.isScreenShareActive(id)) {
            finish(null)
            return
        }
        if (!channel.canSendScreenFrame(id)) {
            h.removeCallbacks(retry)
            h.postDelayed(retry, 30)
            return
        }
        val src = latest ?: return
        val quality = channel.screenQuality(id).coerceIn(30, 85)
        val out = ByteArrayOutputStream(64 * 1024)
        val cropped = if (src.width != width || src.height != height) {
            Bitmap.createBitmap(src, 0, 0, minOf(width, src.width), minOf(height, src.height))
        } else src
        cropped.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (cropped !== src) cropped.recycle()
        if (channel.sendScreenFrame(id, out.toByteArray(), minOf(width, src.width), minOf(height, src.height))) {
            dirty = false
        } else {
            h.removeCallbacks(retry)
            h.postDelayed(retry, 50)
        }
    }

    private val retry = Runnable { pump() }

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
        stopAudio()
        handler?.removeCallbacks(blackCheck)
        runCatching { display?.release() }
        display = null
        runCatching { reader?.close() }
        reader = null
        runCatching { projection?.stop() }
        projection = null
        latest?.recycle()
        latest = null
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
            .setContentText("Everything on screen is visible on the computer, end-to-end encrypted.")
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

        /** Session currently being captured (null = not sharing). */
        @Volatile var activeSessionId: String? = null
            private set(value) {
                field = value
                activeState.value = value
            }
        private val activeState = MutableStateFlow<String?>(null)

        /** Observable [activeSessionId] for the "Cast to computer" card. */
        val active: StateFlow<String?> = activeState.asStateFlow()

        private const val AUDIO_RATE = Continuity.SCREEN_AUDIO_SAMPLE_RATE
        /** 40 ms of 48 kHz stereo s16: small enough for lip sync, few frames per second. */
        private const val AUDIO_CHUNK_BYTES = AUDIO_RATE / 25 * 4
        private const val BLACK_CHECK_MS = 1_500L
        private const val BLACK_CHECKS_BEFORE_NOTICE = 3
        private const val BLACK_NOTICE = "The picture is black? The phone may be locked, or the app on screen blocks capture " +
            "(Netflix, Prime Video, Hotstar and other protected video). That protection can't be bypassed."

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
 *
 * A request answering this phone's own "Cast to computer" invite skips the
 * AirBridge explanation (the user just chose to cast) but never Android's
 * capture prompt. When sound was asked for, RECORD_AUDIO is requested first;
 * declining it only makes the share silent.
 */
class ScreenShareConsentActivity : Activity() {
    private var sessionId: String = ""
    private var decided = false

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
        if (savedInstanceState?.getBoolean(STATE_ASKED) == true) return
        if (request.invited) {
            proceed(request.audio)
            return
        }
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Share your screen with ${request.peerName}?")
            .setMessage(
                "${request.peerName} will see everything on this phone's screen, including notifications, " +
                    "until you stop sharing. The stream is end-to-end encrypted and never leaves your devices.",
            )
            .setPositiveButton("Continue") { _, _ -> proceed(request.audio) }
            .setNegativeButton("Decline") { _, _ -> decline("Declined on the phone") }
            .setOnCancelListener { decline("Declined on the phone") }
            .show()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_ASKED, true)
    }

    /** Sound first (runtime permission, Android 10+), then Android's capture prompt. */
    private fun proceed(audio: Boolean) {
        if (audio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
            return
        }
        askCapture()
    }

    private fun askCapture() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        if (mpm == null) {
            decline("Screen capture is unavailable")
        } else {
            @Suppress("DEPRECATION")
            startActivityForResult(mpm.createScreenCaptureIntent(), REQUEST_CAPTURE)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_AUDIO) askCapture() // denied = share without sound
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
