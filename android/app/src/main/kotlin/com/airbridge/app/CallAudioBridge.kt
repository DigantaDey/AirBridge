package com.airbridge.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Process
import android.util.Log
import androidx.core.content.ContextCompat
import com.airbridge.engine.CallAudioCommand
import com.airbridge.engine.CallAudioController
import com.airbridge.engine.CallAudioFrame
import com.airbridge.engine.CallAudioState
import com.airbridge.engine.Continuity
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Speakerphone-assisted duplex PCM audio bridge for Continuity phone calls.
 *
 * Unrooted Android blocks third-party CAPTURE_AUDIO_OUTPUT from cellular voice
 * calls, so this bridge uses standard VOICE_COMMUNICATION mic/track streams
 * with AcousticEchoCanceler + NoiseSuppressor while placing the phone audio
 * on speaker during an active call.
 */
class CallAudioBridge(
    private val context: Context,
    private val onSendAudio: (
        peerId: String,
        callId: String,
        pcmS16le: ByteArray,
        sampleRate: Int,
        channels: Int,
        frames: Int,
        ptsMs: Long,
    ) -> Boolean,
    private val onStateChanged: ((peerId: String, callId: String, state: CallAudioState) -> Unit)? = null,
) : CallAudioController {

    private val lock = Any()
    private val running = AtomicBoolean(false)

    @Volatile private var activePeerId: String? = null
    @Volatile private var activeCallId: String? = null
    @Volatile private var muted = false

    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null
    private var captureThread: Thread? = null

    private var priorAudioMode: Int? = null
    private var priorSpeakerphone: Boolean? = null

    override fun execute(command: CallAudioCommand): CallAudioState {
        return when (command.action) {
            "start" -> start(command.peerId, command.callId, command.sampleRate ?: Continuity.CALL_AUDIO_SAMPLE_RATE)
            "stop" -> {
                stopAll()
                CallAudioState(active = false, muted = false, route = "phone")
            }
            "mute", "unmute" -> {
                val wantMute = command.action == "mute"
                synchronized(lock) {
                    if (activeCallId != command.callId || !running.get()) {
                        return CallAudioState(active = false, muted = false, route = "phone", reason = "Mac call audio is not active.")
                    }
                    muted = wantMute
                    CallAudioState(active = true, muted = wantMute, route = "computer")
                }
            }
            else -> CallAudioState(active = false, muted = false, route = "phone", reason = "Unsupported call audio command.")
        }
    }

    override fun onIncomingAudio(frame: CallAudioFrame) {
        if (!running.get() || activeCallId != frame.callId || activePeerId != frame.peerId) return
        val track = synchronized(lock) { audioTrack } ?: return
        runCatching {
            val written = track.write(frame.data, 0, frame.data.size, AudioTrack.WRITE_NON_BLOCKING)
            if (written > 0) {
                AndroidDiagnostics.recordCallAudioFrameReceived()
            }
        }
    }

    /** Stops the bridge automatically if the ended call owned it; returns (peerId, true) when active. */
    fun onCallEnded(callId: String): Pair<String, Boolean>? {
        val peer = synchronized(lock) {
            if (activeCallId == callId && running.get()) activePeerId else null
        } ?: return null
        stopAll()
        onStateChanged?.invoke(peer, callId, CallAudioState(active = false, muted = false, route = "phone"))
        return peer to true
    }

    @SuppressLint("MissingPermission")
    private fun start(peerId: String, callId: String, requestedRate: Int): CallAudioState {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            val reason = "Microphone permission required on phone for Mac call audio."
            AndroidDiagnostics.callAudioLastError = reason
            return CallAudioState(active = false, muted = false, route = "phone", reason = reason)
        }
        stopAll()

        val sampleRate = requestedRate.coerceIn(8_000, 48_000)
        val frameSamples = ((sampleRate / 50).coerceAtLeast(160)).coerceAtMost(Continuity.CALL_AUDIO_MAX_FRAMES)
        val frameBytes = frameSamples * 2
        val minRecBuf = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            .coerceAtLeast(frameBytes * 4)
        val minPlayBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            .coerceAtLeast(frameBytes * 4)

        val record = runCatching {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minRecBuf * 2,
            )
        }.onFailure {
            AndroidDiagnostics.callAudioLastError = it.message
            Log.w(TAG, "AudioRecord create failed: ${it.message}")
        }.getOrNull()

        if (record == null || record.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { record?.release() }
            val reason = "Could not open phone microphone for call audio."
            AndroidDiagnostics.callAudioLastError = reason
            return CallAudioState(active = false, muted = false, route = "phone", reason = reason)
        }

        val track = runCatching {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(minPlayBuf * 2)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        }.onFailure {
            AndroidDiagnostics.callAudioLastError = it.message
            Log.w(TAG, "AudioTrack create failed: ${it.message}")
        }.getOrNull()

        if (track == null || track.state != AudioTrack.STATE_INITIALIZED) {
            runCatching { record.release() }
            runCatching { track?.release() }
            val reason = "Could not open phone voice output for call audio."
            AndroidDiagnostics.callAudioLastError = reason
            return CallAudioState(active = false, muted = false, route = "phone", reason = reason)
        }

        val audioManager = context.getSystemService(AudioManager::class.java)
        synchronized(lock) {
            activePeerId = peerId
            activeCallId = callId
            muted = false
            audioRecord = record
            audioTrack = track
            aec = if (AcousticEchoCanceler.isAvailable()) {
                runCatching { AcousticEchoCanceler.create(record.audioSessionId)?.apply { enabled = true } }.getOrNull()
            } else null
            ns = if (NoiseSuppressor.isAvailable()) {
                runCatching { NoiseSuppressor.create(record.audioSessionId)?.apply { enabled = true } }.getOrNull()
            } else null

            if (audioManager != null) {
                priorAudioMode = audioManager.mode
                @Suppress("DEPRECATION")
                priorSpeakerphone = audioManager.isSpeakerphoneOn
                runCatching { audioManager.mode = AudioManager.MODE_IN_COMMUNICATION }
                setSpeakerphone(audioManager, enabled = true)
            }
            running.set(true)
            AndroidDiagnostics.callAudioActive = true
            AndroidDiagnostics.callAudioLastError = null
        }

        return try {
            track.play()
            record.startRecording()
            captureThread = thread(start = true, name = "airbridge-call-audio") {
                runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO) }
                val buf = ByteArray(frameBytes)
                var totalSamples = 0L
                while (running.get()) {
                    val read = runCatching {
                        record.read(buf, 0, buf.size, AudioRecord.READ_BLOCKING)
                    }.getOrDefault(-1)
                    if (read <= 0) continue
                    val samples = read / 2
                    if (samples <= 0) continue
                    val ptsMs = ((totalSamples * 1000L) / sampleRate) and 0xffffffffL
                    totalSamples += samples
                    if (muted) continue
                    val packet = if (samples * 2 == buf.size) buf.copyOf() else buf.copyOf(samples * 2)
                    if (onSendAudio(peerId, callId, packet, sampleRate, 1, samples, ptsMs)) {
                        AndroidDiagnostics.recordCallAudioFrameSent()
                    }
                }
            }
            CallAudioState(active = true, muted = false, route = "computer")
        } catch (e: Exception) {
            AndroidDiagnostics.callAudioLastError = e.message
            stopAll()
            CallAudioState(active = false, muted = false, route = "phone", reason = e.message ?: "Call audio start failed.")
        }
    }

    private fun setSpeakerphone(audioManager: AudioManager, enabled: Boolean) {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (enabled) {
                    val speaker = audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    }
                    if (speaker != null) audioManager.setCommunicationDevice(speaker)
                } else {
                    audioManager.clearCommunicationDevice()
                }
            }
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = enabled
        }
    }

    fun stopAll() {
        val threadToJoin: Thread?
        val rec: AudioRecord?
        val trk: AudioTrack?
        val prevMode: Int?
        val prevSpeaker: Boolean?
        val curAec: AcousticEchoCanceler?
        val curNs: NoiseSuppressor?
        synchronized(lock) {
            running.set(false)
            activePeerId = null
            activeCallId = null
            muted = false
            threadToJoin = captureThread
            captureThread = null
            rec = audioRecord
            audioRecord = null
            trk = audioTrack
            audioTrack = null
            curAec = aec
            aec = null
            curNs = ns
            ns = null
            prevMode = priorAudioMode
            priorAudioMode = null
            prevSpeaker = priorSpeakerphone
            priorSpeakerphone = null
            AndroidDiagnostics.callAudioActive = false
        }
        runCatching { rec?.stop() }
        runCatching { rec?.release() }
        runCatching { trk?.pause() }
        runCatching { trk?.flush() }
        runCatching { trk?.stop() }
        runCatching { trk?.release() }
        runCatching { curAec?.release() }
        runCatching { curNs?.release() }
        runCatching { threadToJoin?.join(400) }
        val audioManager = runCatching { context.getSystemService(AudioManager::class.java) }.getOrNull()
        if (audioManager != null && (prevMode != null || prevSpeaker != null)) {
            runCatching {
                setSpeakerphone(audioManager, prevSpeaker ?: false)
                if (prevMode != null) audioManager.mode = prevMode
            }
        }
    }

    companion object {
        private const val TAG = "AirBridgeCallAudio"
    }
}
