package com.airbridge.app

import com.airbridge.engine.ConnectionState
import com.airbridge.engine.EngineDiagnosticsSnapshot
import com.airbridge.engine.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContinuityAndDiagnosticsTest {

    private fun annexB(vararg nalus: ByteArray): ByteArray {
        val total = nalus.sumOf { 4 + it.size }
        val out = ByteArray(total)
        var offset = 0
        for (nalu in nalus) {
            out[offset + 3] = 1
            System.arraycopy(nalu, 0, out, offset + 4, nalu.size)
            offset += 4 + nalu.size
        }
        return out
    }

    @Test
    fun screenSharePrependsCachedCodecConfigOnlyWhenKeyFrameLacksSpsOrPps() {
        val sps = byteArrayOf(0x67, 0x42, 0xc0.toByte(), 0x28)
        val pps = byteArrayOf(0x68, 0xce.toByte(), 0x3c, 0x80.toByte())
        val idr = byteArrayOf(0x65, 0x88.toByte(), 0x84.toByte())
        val codecConfig = annexB(sps, pps)

        val bareKey = annexB(idr)
        val withHeaders = ScreenShareService.ensureAnnexBKeyFrameHeaders(bareKey, codecConfig)
        assertEquals(codecConfig.size + bareKey.size, withHeaders.size)

        // When both SPS and PPS are already inline, nothing is duplicated
        val inlineKey = annexB(sps, pps, idr)
        val unchanged = ScreenShareService.ensureAnnexBKeyFrameHeaders(inlineKey, codecConfig)
        assertTrue(unchanged === inlineKey)
    }

    @Test
    fun clipboardImageProviderParsesMimeAndImageBytesSafely() {
        assertEquals("png", ClipboardImageProvider.extensionForMime("image/png"))
        assertEquals("jpg", ClipboardImageProvider.extensionForMime("image/jpeg"))
        assertEquals("webp", ClipboardImageProvider.extensionForMime("image/webp"))
        assertEquals("gif", ClipboardImageProvider.extensionForMime("image/gif"))

        val validPng =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z2WkAAAAASUVORK5CYII="
        val parsed = ClipboardImageProvider.parseImageDataUrl(validPng)
        assertNotNull(parsed)
        assertEquals("png", parsed!!.first)
        assertTrue(parsed.second.isNotEmpty())

        assertNull(ClipboardImageProvider.parseImageDataUrl("data:text/plain;base64,SGVsbG8="))
        assertFalse(ConnectionService.isOwnImageSuppressed(0L))
    }

    @Test
    fun androidDiagnosticsIncludesScreenShareClipboardImageCallAudioAndEngineResilienceFields() {
        AndroidDiagnostics.recordScreenCodecConfigCached()
        AndroidDiagnostics.recordScreenKeyFrameSent()
        AndroidDiagnostics.recordScreenFrameDropped()
        AndroidDiagnostics.recordScreenPliReceived()
        AndroidDiagnostics.recordClipboardImageReceived()
        AndroidDiagnostics.recordClipboardImageSuppressedEcho()
        AndroidDiagnostics.recordCallAudioFrameSent()
        AndroidDiagnostics.recordCallAudioFrameReceived()
        AndroidDiagnostics.callAudioLastError = "Microphone unavailable at /Users/alice/secret.wav"

        val snap = EngineDiagnosticsSnapshot(
            connectionState = ConnectionState.CONNECTED,
            tlsMode = "pinned",
            tlsAnchored = true,
            verifiedIpSanHost = "192.168.1.10",
            anchorPinPrefix = "sha256/abc",
            connectedHost = "192.168.1.10",
            connectedViaReverse = false,
            connectedViaRelay = false,
            admission = "pake",
            reversePort = null,
            wsConnectAttempts = 2L,
            wsLastDnsMs = 5L,
            wsWriteStallCount = 0L,
            wsActiveDialThreads = 0,
            lastAttempts = emptyList(),
            activeTransferCount = 1,
            peerCount = 1,
            transferResumes = 3L,
            transferInterruptions = 2L,
            outboundBatchFlushes = 42L,
        )

        val report = AndroidDiagnostics.collectReportJson(engineSnapshotOverride = snap)
        val screenShare = report.optObj("screenShare")!!
        assertEquals(true, screenShare.optBool("codecConfigCached"))
        assertTrue((screenShare.optLong("keyFramesSent") ?: 0L) >= 1L)
        assertTrue((screenShare.optLong("framesDropped") ?: 0L) >= 1L)
        assertTrue((screenShare.optLong("pliReceived") ?: 0L) >= 1L)

        val clipImg = report.optObj("clipboardImages")!!
        assertTrue((clipImg.optLong("received") ?: 0L) >= 1L)
        assertTrue((clipImg.optLong("suppressedEchoes") ?: 0L) >= 1L)

        val callAudio = report.optObj("callAudio")!!
        assertTrue((callAudio.optLong("framesSent") ?: 0L) >= 1L)
        assertTrue((callAudio.optLong("framesReceived") ?: 0L) >= 1L)
        val redactedErr = callAudio.optStr("lastError") ?: ""
        assertFalse(redactedErr.contains("/Users/alice"))

        val engineObj = report.optObj("engine")!!
        assertEquals(3L, engineObj.optLong("transferResumes"))
        assertEquals(2L, engineObj.optLong("transferInterruptions"))
        assertEquals(42L, engineObj.optLong("outboundBatchFlushes"))

        // Clean nullable field after test
        AndroidDiagnostics.callAudioLastError = null
        assertTrue(report is JsonValue.Obj)
    }
}
