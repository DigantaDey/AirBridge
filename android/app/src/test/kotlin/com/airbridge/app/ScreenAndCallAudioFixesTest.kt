package com.airbridge.app

import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaRecorder
import com.airbridge.engine.ConnectionState
import com.airbridge.engine.EngineDiagnosticsSnapshot
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ScreenAndCallAudioFixesTest {

    private fun resolveRepoFile(relativePath: String): File? {
        var dir: File? = File(System.getProperty("user.dir") ?: ".")
        repeat(6) {
            if (dir != null) {
                val candidate = File(dir, relativePath)
                if (candidate.isFile) return candidate
                dir = dir!!.parentFile
            }
        }
        return null
    }

    @Test
    fun pcmAudioMetricsDetectsSilenceVsSignalAccurately() {
        val silence = ByteArray(1920)
        assertEquals(0.0, PcmAudioMetrics.computePcm16Rms(silence), 1e-6)
        assertFalse(PcmAudioMetrics.hasNonZeroPcm16(silence))

        // Constant +8192 amplitude in S16LE -> RMS ~= 0.25
        val tone = ByteArray(640)
        for (i in 0 until 320) {
            tone[i * 2] = 0x00
            tone[i * 2 + 1] = 0x20
        }
        val rms = PcmAudioMetrics.computePcm16Rms(tone)
        assertEquals(0.25, rms, 0.005)
        assertTrue(PcmAudioMetrics.hasNonZeroPcm16(tone))
    }

    @Test
    fun screenShareEncoderParamsClampFpsAndSetLowLatencyRepeatInterval() {
        val params30 = ScreenShareService.computeVideoEncoderParams(
            width = 1280,
            height = 576,
            maxFps = 30,
            qualityPercent = 70,
        )
        assertEquals(30, params30.maxFps)
        assertEquals(30f, params30.maxFpsToEncoder, 0.001f)
        assertEquals(250_000L, params30.repeatPreviousFrameAfterUs)
        assertEquals(2, params30.iFrameIntervalSec)
        assertTrue(params30.bitrateBps in 500_000..8_000_000)

        val clamped = ScreenShareService.computeVideoEncoderParams(
            width = 1280,
            height = 720,
            maxFps = 120,
            qualityPercent = 85,
        )
        assertEquals(30, clamped.maxFps)
        assertEquals(30f, clamped.maxFpsToEncoder, 0.001f)
    }

    @Test
    fun callAudioBridgePolicyDisablesPhoneAecKeepsInCallModeAndSelectsCellularRouting() {
        assertArrayEquals(
            intArrayOf(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                MediaRecorder.AudioSource.MIC,
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            ),
            CallAudioBridge.selectCaptureSources(inCellularCall = true),
        )
        assertArrayEquals(
            intArrayOf(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                MediaRecorder.AudioSource.MIC,
            ),
            CallAudioBridge.selectCaptureSources(inCellularCall = false),
        )

        assertFalse(CallAudioBridge.shouldUsePhoneAec(inCellularCall = true))
        assertTrue(CallAudioBridge.shouldUsePhoneAec(inCellularCall = false))

        assertFalse(CallAudioBridge.shouldSetCommunicationMode(AudioManager.MODE_IN_CALL))
        assertTrue(CallAudioBridge.shouldSetCommunicationMode(AudioManager.MODE_NORMAL))

        assertEquals(AudioAttributes.USAGE_MEDIA, CallAudioBridge.selectAudioTrackUsage(inCellularCall = true))
        assertEquals(
            AudioAttributes.USAGE_VOICE_COMMUNICATION,
            CallAudioBridge.selectAudioTrackUsage(inCellularCall = false),
        )
        assertEquals("VOICE_RECOGNITION", CallAudioBridge.audioSourceLabel(MediaRecorder.AudioSource.VOICE_RECOGNITION))
        assertEquals("MODE_IN_CALL", CallAudioBridge.audioModeLabel(AudioManager.MODE_IN_CALL))
    }

    @Test
    fun manifestDeclaresDedicatedMicrophoneCallAudioServiceWhilePreservingConnectionService() {
        val manifestFile = resolveRepoFile("android/app/src/main/AndroidManifest.xml")
        assertNotNull(manifestFile)
        val xml = manifestFile!!.readText()
        assertTrue(xml.contains("android:name=\".ConnectionService\""))
        assertTrue(xml.contains("android:foregroundServiceType=\"connectedDevice|dataSync\""))
        assertTrue(xml.contains("android:name=\".CallAudioService\""))
        assertTrue(xml.contains("android:foregroundServiceType=\"microphone\""))
    }

    @Test
    fun androidDiagnosticsCollectReportIncludesScreenAudioCallAudioAndEngineCountersWithRedaction() {
        AndroidDiagnostics.screenShareTargetFps = 30
        AndroidDiagnostics.screenShareWidth = 1280
        AndroidDiagnostics.screenShareHeight = 576
        AndroidDiagnostics.screenShareBitrateBps = 2_400_000
        AndroidDiagnostics.screenShareInFlight = 2
        AndroidDiagnostics.screenShareLastAckRttMs = 14L
        AndroidDiagnostics.recordScreenPFrameSent()
        AndroidDiagnostics.recordScreenAudioFrameCaptured(nonZero = true, rms = 0.25)
        AndroidDiagnostics.recordScreenAudioFrameSent(sent = true)

        AndroidDiagnostics.callAudioFgsMicPromoted = true
        AndroidDiagnostics.callAudioFgsMicError = "FGS error at /Users/diganta/test pair=ABC-123"
        AndroidDiagnostics.callAudioSourceUsed = "VOICE_RECOGNITION"
        AndroidDiagnostics.callAudioAndroidMode = "MODE_IN_CALL"
        AndroidDiagnostics.callAudioSpeakerphoneOn = true
        AndroidDiagnostics.callAudioClientSilenced = false
        AndroidDiagnostics.recordCallAudioFrameSent(nonZero = true, rms = 0.18)
        AndroidDiagnostics.recordCallAudioTrackWrite(640)

        val engineSnap = EngineDiagnosticsSnapshot(
            connectionState = ConnectionState.CONNECTED,
            tlsMode = "pinned",
            tlsAnchored = true,
            verifiedIpSanHost = "192.168.1.5",
            anchorPinPrefix = "sha256/test",
            connectedHost = "192.168.1.5",
            connectedViaReverse = false,
            connectedViaRelay = false,
            admission = "pake",
            reversePort = null,
            wsConnectAttempts = 1L,
            wsLastDnsMs = 3L,
            wsWriteStallCount = 0L,
            wsActiveDialThreads = 0,
            lastAttempts = emptyList(),
            activeTransferCount = 0,
            peerCount = 1,
            screenFramesWindowRejected = 1L,
            screenFramesSocketRejected = 2L,
            screenAudioFramesSent = 30L,
            screenAudioFramesDropped = 1L,
            callAudioFramesSent = 50L,
            callAudioFramesReceived = 48L,
        )

        val report = AndroidDiagnostics.collectReportJson(engineSnapshotOverride = engineSnap)
        val screenShare = report.optObj("screenShare")!!
        assertEquals(30L, screenShare.optLong("targetFps"))
        assertEquals(1280L, screenShare.optLong("width"))
        assertEquals(576L, screenShare.optLong("height"))
        assertEquals(2_400_000L, screenShare.optLong("bitrateBps"))
        assertEquals(2L, screenShare.optLong("inFlightFrames"))
        assertEquals(14L, screenShare.optLong("lastAckRttMs"))
        assertTrue((screenShare.optLong("pFramesSent") ?: 0L) >= 1L)
        assertTrue((screenShare.optLong("audioFramesCaptured") ?: 0L) >= 1L)
        assertTrue((screenShare.optLong("audioNonZeroFrames") ?: 0L) >= 1L)
        assertTrue((screenShare.optLong("audioFramesSent") ?: 0L) >= 1L)

        val callAudio = report.optObj("callAudio")!!
        assertEquals(true, callAudio.optBool("fgsMicPromoted"))
        val redactedFgsErr = callAudio.optStr("fgsMicError") ?: ""
        assertFalse(redactedFgsErr.contains("/Users/diganta"))
        assertFalse(redactedFgsErr.contains("ABC-123"))
        assertEquals("VOICE_RECOGNITION", callAudio.optStr("audioSourceUsed"))
        assertEquals("MODE_IN_CALL", callAudio.optStr("androidAudioMode"))
        assertEquals(true, callAudio.optBool("speakerphoneOn"))
        assertEquals(false, callAudio.optBool("clientSilenced"))
        assertTrue((callAudio.optLong("nonZeroFramesSent") ?: 0L) >= 1L)
        assertTrue((callAudio.optLong("trackFramesWritten") ?: 0L) >= 1L)

        val engineObj = report.optObj("engine")!!
        assertEquals(1L, engineObj.optLong("screenFramesWindowRejected"))
        assertEquals(2L, engineObj.optLong("screenFramesSocketRejected"))
        assertEquals(30L, engineObj.optLong("screenAudioFramesSent"))
        assertEquals(1L, engineObj.optLong("screenAudioFramesDropped"))
        assertEquals(50L, engineObj.optLong("callAudioFramesSent"))
        assertEquals(48L, engineObj.optLong("callAudioFramesReceived"))

        AndroidDiagnostics.callAudioFgsMicError = null
        AndroidDiagnostics.callAudioFgsMicPromoted = false
    }
}
