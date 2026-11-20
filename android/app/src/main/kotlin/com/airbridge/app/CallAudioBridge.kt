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
import android.os.Handler
import android.os.Looper
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
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    @Volatile private var activePeerId: String? = null
    @Volatile private var activeCallId: String? = null
    @Volatile private var muted = false

    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null
    private var captureThread: Thread? = null
    private var speakerReassertRunnable: Runnable? = null

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
        if (!running.get() || activeCallId != frame.callId || activePeerId != frame.peerId || muted) return
        val track = synchronized(lock) { audioTrack } ?: return
        runCatching {
            val written = track.write(frame.data, 0, frame.data.size, AudioTrack.WRITE_NON_BLOCKING)
            AndroidDiagnostics.recordCallAudioTrackWrite(written)
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

        CallAudioService.onStopRequested = {
            val peer = synchronized(lock) { activePeerId }
            val activeCall = synchronized(lock) { activeCallId }
            stopAll()
            if (peer != null && activeCall != null) {
                onStateChanged?.invoke(peer, activeCall, CallAudioState(active = false, muted = false, route = "phone"))
            }
        }
        val (fgsOk, fgsErr) = CallAudioService.start(context)

        val audioManager = context.getSystemService(AudioManager::class.java)
        val detectedMode = audioManager?.mode ?: AudioManager.MODE_NORMAL
        val inCellularCall = detectedMode == AudioManager.MODE_IN_CALL
        AndroidDiagnostics.callAudioAndroidMode = audioModeLabel(detectedMode)

        val sampleRate = requestedRate.coerceIn(8_000, 48_000)
        val frameSamples = ((sampleRate / 50).coerceAtLeast(160)).coerceAtMost(Continuity.CALL_AUDIO_MAX_FRAMES)
        val frameBytes = frameSamples * 2
        val minRecBuf = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            .coerceAtLeast(frameBytes * 4)
        val minPlayBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            .coerceAtLeast(frameBytes * 4)

        var record: AudioRecord? = null
        var chosenSource = -1
        for (source in selectCaptureSources(inCellularCall)) {
            val candidate = runCatching {
                AudioRecord(
                    source,
                    sampleRate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    minRecBuf * 2,
                )
            }.onFailure {
                AndroidDiagnostics.callAudioLastError = it.message
                Log.w(TAG, "AudioRecord create failed for ${audioSourceLabel(source)}: ${it.message}")
            }.getOrNull()
            if (candidate != null && candidate.state == AudioRecord.STATE_INITIALIZED) {
                record = candidate
                chosenSource = source
                break
            }
            runCatching { candidate?.release() }
        }

        if (record == null || record.state != AudioRecord.STATE_INITIALIZED) {
            CallAudioService.stop(context)
            CallAudioService.onStopRequested = null
            val reason = "Could not open phone microphone for call audio."
            AndroidDiagnostics.callAudioLastError = reason
            AndroidDiagnostics.callAudioSourceUsed = "failed"
            return CallAudioState(active = false, muted = false, route = "phone", reason = reason)
        }
        AndroidDiagnostics.callAudioSourceUsed = audioSourceLabel(chosenSource)

        val preferredUsage = selectAudioTrackUsage(inCellularCall)
        val usageCandidates = if (preferredUsage == AudioAttributes.USAGE_VOICE_COMMUNICATION) {
            intArrayOf(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        } else {
            intArrayOf(preferredUsage, AudioAttributes.USAGE_VOICE_COMMUNICATION)
        }
        var track: AudioTrack? = null
        for (usage in usageCandidates) {
            val candidate = runCatching {
                AudioTrack.Builder()
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(usage)
                            .setContentType(
                                if (usage == AudioAttributes.USAGE_MEDIA) AudioAttributes.CONTENT_TYPE_MUSIC
                                else AudioAttributes.CONTENT_TYPE_SPEECH,
                            )
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
                Log.w(TAG, "AudioTrack create failed (usage=$usage): ${it.message}")
            }.getOrNull()
            if (candidate != null && candidate.state == AudioTrack.STATE_INITIALIZED) {
                track = candidate
                break
            }
            runCatching { candidate?.release() }
        }

        if (track == null || track.state != AudioTrack.STATE_INITIALIZED) {
            runCatching { record.release() }
            CallAudioService.stop(context)
            CallAudioService.onStopRequested = null
            val reason = "Could not open phone voice output for call audio."
            AndroidDiagnostics.callAudioLastError = reason
            return CallAudioState(active = false, muted = false, route = "phone", reason = reason)
        }

        if (inCellularCall && audioManager != null) {
            runCatching {
                val builtinSpeaker = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull {
                    it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                }
                if (builtinSpeaker != null) {
                    track.setPreferredDevice(builtinSpeaker)
                }
            }
        }

        synchronized(lock) {
            activePeerId = peerId
            activeCallId = callId
            muted = false
            audioRecord = record
            audioTrack = track
            val usePhoneAec = shouldUsePhoneAec(inCellularCall)
            aec = if (usePhoneAec && AcousticEchoCanceler.isAvailable()) {
                runCatching { AcousticEchoCanceler.create(record.audioSessionId)?.apply { enabled = true } }.getOrNull()
            } else null
            ns = if (usePhoneAec && NoiseSuppressor.isAvailable()) {
                runCatching { NoiseSuppressor.create(record.audioSessionId)?.apply { enabled = true } }.getOrNull()
            } else null

            if (audioManager != null) {
                priorAudioMode = audioManager.mode
                @Suppress("DEPRECATION")
                priorSpeakerphone = audioManager.isSpeakerphoneOn
                if (shouldSetCommunicationMode(detectedMode)) {
                    runCatching { audioManager.mode = AudioManager.MODE_IN_COMMUNICATION }
                }
                setSpeakerphone(audioManager, enabled = true)
                AndroidDiagnostics.callAudioSpeakerphoneOn = isSpeakerphoneOnCompat(audioManager)
                val reassert = Runnable {
                    if (running.get()) {
                        setSpeakerphone(audioManager, enabled = true)
                        AndroidDiagnostics.callAudioSpeakerphoneOn = isSpeakerphoneOnCompat(audioManager)
                    }
                }
                speakerReassertRunnable = reassert
                runCatching { mainHandler.postDelayed(reassert, 250L) }
            }
            running.set(true)
            AndroidDiagnostics.callAudioActive = true
            AndroidDiagnostics.callAudioClientSilenced = false
            if (fgsOk || fgsErr == null) {
                AndroidDiagnostics.callAudioLastError = null
            }
        }

        val initialWarning = if (!fgsOk && fgsErr != null) {
            "Open AirBridge on the phone if Mac call audio stays silent (${fgsErr.take(120)})."
        } else null

        return try {
            track.play()
            record.startRecording()
            captureThread = thread(start = true, name = "airbridge-call-audio") {
                runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO) }
                val buf = ByteArray(frameBytes)
                var totalSamples = 0L
                var frameCounter = 0
                var consecutiveSilencedChecks = 0
                var silencedReported = false
                while (running.get()) {
                    val read = runCatching {
                        record.read(buf, 0, buf.size, AudioRecord.READ_BLOCKING)
                    }.getOrDefault(-1)
                    if (read <= 0) continue
                    val samples = read / 2
                    if (samples <= 0) continue
                    val sampleBytes = samples * 2
                    val ptsMs = ((totalSamples * 1000L) / sampleRate) and 0xffffffffL
                    totalSamples += samples
                    frameCounter += 1
                    val rms = PcmAudioMetrics.computePcm16Rms(buf, sampleBytes)
                    val nonZero = PcmAudioMetrics.hasNonZeroPcm16(buf, sampleBytes)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && frameCounter % 25 == 0 && !silencedReported) {
                        val silenced = runCatching { record.activeRecordingConfiguration?.isClientSilenced == true }.getOrDefault(false)
                        if (silenced) {
                            consecutiveSilencedChecks += 1
                            if (consecutiveSilencedChecks >= 2) {
                                silencedReported = true
                                val msg = "Android silenced background microphone capture during this cellular call. Open AirBridge on the phone or use phone speakerphone."
                                AndroidDiagnostics.callAudioClientSilenced = true
                                AndroidDiagnostics.callAudioLastError = msg
                                AndroidDiagnostics.recordEvent("callAudio", msg, "WARN")
                                onStateChanged?.invoke(
                                    peerId,
                                    callId,
                                    CallAudioState(active = true, muted = muted, route = "computer", reason = msg),
                                )
                            }
                        } else {
                            consecutiveSilencedChecks = 0
                        }
                    }
                    // Always continue forwarding phone/speakerphone audio toward Mac even when Mac mic is muted.
                    val packet = if (sampleBytes == buf.size) buf.copyOf() else buf.copyOf(sampleBytes)
                    val sent = onSendAudio(peerId, callId, packet, sampleRate, 1, samples, ptsMs)
                    if (sent) {
                        AndroidDiagnostics.recordCallAudioFrameSent(nonZero, rms)
                    }
                }
            }
            CallAudioState(active = true, muted = false, route = "computer", reason = initialWarning)
        } catch (e: Exception) {
            AndroidDiagnostics.callAudioLastError = e.message
            stopAll()
            CallAudioState(active = false, muted = false, route = "phone", reason = e.message ?: "Call audio start failed.")
        }
    }

    private fun isSpeakerphoneOnCompat(audioManager: AudioManager): Boolean = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER ||
                @Suppress("DEPRECATION") audioManager.isSpeakerphoneOn
        } else {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn
        }
    }.getOrDefault(false)

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
        val pendingSpeakerCallback: Runnable?
        synchronized(lock) {
            running.set(false)
            activePeerId = null
            activeCallId = null
            muted = false
            threadToJoin = captureThread
            captureThread = null
            pendingSpeakerCallback = speakerReassertRunnable
            speakerReassertRunnable = null
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
            AndroidDiagnostics.callAudioClientSilenced = false
            AndroidDiagnostics.callAudioSpeakerphoneOn = false
        }
        pendingSpeakerCallback?.let { runCatching { mainHandler.removeCallbacks(it) } }
        CallAudioService.onStopRequested = null
        CallAudioService.stop(context)
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
                if (prevMode != null && shouldSetCommunicationMode(prevMode)) {
                    audioManager.mode = prevMode
                }
            }
        }
    }

    companion object {
        private const val TAG = "AirBridgeCallAudio"

        internal fun selectCaptureSources(inCellularCall: Boolean): IntArray = if (inCellularCall) {
            intArrayOf(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                MediaRecorder.AudioSource.MIC,
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            )
        } else {
            intArrayOf(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                MediaRecorder.AudioSource.MIC,
            )
        }

        internal fun shouldUsePhoneAec(inCellularCall: Boolean): Boolean = !inCellularCall

        internal fun shouldSetCommunicationMode(currentMode: Int): Boolean =
            currentMode != AudioManager.MODE_IN_CALL

        internal fun selectAudioTrackUsage(inCellularCall: Boolean): Int = if (inCellularCall) {
            AudioAttributes.USAGE_MEDIA
        } else {
            AudioAttributes.USAGE_VOICE_COMMUNICATION
        }

        internal fun audioSourceLabel(source: Int): String = when (source) {
            MediaRecorder.AudioSource.VOICE_RECOGNITION -> "VOICE_RECOGNITION"
            MediaRecorder.AudioSource.MIC -> "MIC"
            MediaRecorder.AudioSource.VOICE_COMMUNICATION -> "VOICE_COMMUNICATION"
            else -> "SOURCE_$source"
        }

        internal fun audioModeLabel(mode: Int): String = when (mode) {
            AudioManager.MODE_NORMAL -> "MODE_NORMAL"
            AudioManager.MODE_RINGTONE -> "MODE_RINGTONE"
            AudioManager.MODE_IN_CALL -> "MODE_IN_CALL"
            AudioManager.MODE_IN_COMMUNICATION -> "MODE_IN_COMMUNICATION"
            else -> "MODE_$mode"
        }
    }
}
