package com.airbridge.engine

import java.util.Collections
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.spec.SecretKeySpec
import kotlin.system.exitProcess

private var passed = 0
private var failed = 0

private fun expect(name: String, ok: Boolean, detail: String = "") {
    if (ok) passed++ else {
        failed++
        println("FAIL $name $detail")
    }
}

private class ContinuityVideoAudioHost : ContinuityChannel.Host {
    val sent = Collections.synchronizedList(mutableListOf<Pair<String, JsonValue.Obj>>())
    val frames = Collections.synchronizedList(mutableListOf<Pair<String, ByteArray>>())
    val listeners = CopyOnWriteArrayList<EngineListener>()
    val peers = linkedMapOf<String, Peer>()
    val authorized = mutableSetOf<String>()
    val key = SecretKeySpec(ByteArray(32) { 0x55 }, "AES")
    var sendFrameResult = true

    override fun sendControl(peerId: String, payload: JsonValue.Obj) { sent.add(peerId to payload) }
    override fun sendFrame(peerId: String, innerFrame: ByteArray): Boolean {
        if (!sendFrameResult) return false
        frames.add(peerId to innerFrame)
        return true
    }
    override fun sessionKey(peerId: String): SecretKeySpec? = if (peers.containsKey(peerId)) key else null
    override fun peer(peerId: String): Peer? = peers[peerId]
    override fun isAuthorized(peerId: String): Boolean = peerId in authorized && peers[peerId]?.discoveryScope == "paired"
    override fun isPaired(peerId: String): Boolean = peers[peerId]?.discoveryScope == "paired"
    override fun peerIds(): List<String> = peers.keys.toList()
    override fun execute(task: () -> Unit) = task()
    override fun executeContactQuery(task: () -> Unit) = task()
    override fun schedule(delayMs: Long, task: () -> Unit) {}
    override fun listeners(): Iterable<EngineListener> = listeners
}

fun main() {
    val mac = "aaaaaaaaaaaaaaaa"
    val host = ContinuityVideoAudioHost()
    host.peers[mac] = Peer(mac, DeviceProfile("MacBook", "macos", "MacBook", "laptop", "pk-mac"), "paired", 1L, verified = true)
    host.authorized.add(mac)

    val channel = ContinuityChannel(host)
    channel.screenSourceAvailable = true

    // 1. Constant verification for 30fps H.264 burst window
    expect("screen.h264-inflight-12", Continuity.SCREEN_VIDEO_MAX_INFLIGHT == 12)

    val sid = "1234567890abcdef"
    channel.handleControl(mac, JsonValue.Obj().put("kind", "screen-share-request").put("sessionId", sid).put("maxWidth", 1280).put("maxFps", 30))
    channel.acceptScreenShare(sid)

    val idr = byteArrayOf(0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0, 0, 0, 1, 0x65, 0x88.toByte())
    val pFrame = byteArrayOf(0, 0, 0, 1, 0x41, 0x9a.toByte(), 0x22)

    // 2. Immediate back-to-back H.264 keyframe + P-frames within <1 ms must NOT be dropped by JPEG interval limiter
    val keySent = channel.sendScreenVideoFrame(sid, idr, 1280, 576, 0L, keyFrame = true)
    var immediatePFramesSent = 0
    for (i in 1 until Continuity.SCREEN_VIDEO_MAX_INFLIGHT) {
        if (channel.sendScreenVideoFrame(sid, pFrame, 1280, 576, i * 16L, keyFrame = false)) {
            immediatePFramesSent++
        }
    }
    expect(
        "screen.h264-burst-no-interval-drop",
        keySent && immediatePFramesSent == Continuity.SCREEN_VIDEO_MAX_INFLIGHT - 1,
        "keySent=$keySent immediatePFramesSent=$immediatePFramesSent",
    )
    expect(
        "screen.h264-inflight-tracked",
        channel.screenSourceInFlight(sid) == Continuity.SCREEN_VIDEO_MAX_INFLIGHT,
        "inFlight=${channel.screenSourceInFlight(sid)}",
    )

    // 3. Exceeding SCREEN_VIDEO_MAX_INFLIGHT without ack rejects window & increments counter
    val overflowAccepted = channel.sendScreenVideoFrame(sid, pFrame, 1280, 576, 400L, keyFrame = false)
    expect(
        "screen.window-overflow-rejected-and-counted",
        !overflowAccepted && channel.screenFramesWindowRejectedCount.get() == 1L,
    )

    // 4. Ack advances window + records RTT, enabling a full 30-frame GOP with 0 window drops
    val ackTarget = Continuity.decodeScreenFrame(host.frames.last().second).seq
    channel.handleControl(mac, JsonValue.Obj().put("kind", "screen-share-ack").put("sessionId", sid).put("seq", ackTarget))
    expect(
        "screen.ack-clears-inflight-and-records-rtt",
        channel.screenSourceInFlight(sid) == 0 && (channel.screenSourceLastAckRttMs(sid) ?: -1L) >= 0L,
    )
    val rejectsBeforeGop = channel.screenFramesWindowRejectedCount.get()
    var gopSent = 0
    for (f in 0 until 30) {
        val ok = if (f == 0) {
            channel.sendScreenVideoFrame(sid, idr, 1280, 576, 500L, keyFrame = true)
        } else {
            channel.sendScreenVideoFrame(sid, pFrame, 1280, 576, 500L + f * 33L, keyFrame = false)
        }
        if (ok) {
            gopSent++
            val seq = Continuity.decodeScreenFrame(host.frames.last().second).seq
            channel.handleControl(mac, JsonValue.Obj().put("kind", "screen-share-ack").put("sessionId", sid).put("seq", seq))
        }
    }
    expect("screen.full-30fps-gop-zero-rejects", gopSent == 30 && channel.screenFramesWindowRejectedCount.get() == rejectsBeforeGop)

    // 5. Socket drop telemetry + audio sent/dropped telemetry
    host.sendFrameResult = false
    expect("screen.socket-drop-counted", !channel.sendScreenVideoFrame(sid, pFrame, 1280, 576, 1600L, keyFrame = false) && channel.screenFramesSocketRejectedCount.get() == 1L)
    channel.setScreenAudioAvailable(sid, true)
    val pcm = ByteArray(960 * 2 * 2) { (it and 0xff).toByte() }
    expect("screen.audio-drop-counted", !channel.sendScreenAudio(sid, pcm, 48_000, 2, 960, 0L) && channel.screenAudioFramesDroppedCount.get() == 1L)
    host.sendFrameResult = true
    expect("screen.audio-sent-counted", channel.sendScreenAudio(sid, pcm, 48_000, 2, 960, 20L) && channel.screenAudioFramesSentCount.get() == 1L)

    // 6. Legacy JPEG path still enforces 1000/maxFps interval gating
    val jpegSid = "fedcba0987654321"
    channel.handleControl(mac, JsonValue.Obj().put("kind", "screen-share-request").put("sessionId", jpegSid).put("maxWidth", 1280).put("maxFps", 30))
    channel.acceptScreenShare(jpegSid)
    val jpeg = ByteArray(2048) { 0x11 }
    expect("screen.jpeg-first-sent", channel.sendScreenFrame(jpegSid, jpeg, 1280, 576))
    expect("screen.jpeg-still-paced", !channel.canSendScreenFrame(jpegSid, keyFrame = false, codec = Continuity.SCREEN_CODEC_JPEG))

    // 7. EngineDiagnosticsSnapshot new default + populated fields
    val engine = AirBridgeEngine(EngineConfig(serverUrl = "ws://127.0.0.1:0", deviceName = "TestPhone"))
    val snap = engine.diagnosticsSnapshot()
    expect(
        "engine.snapshot-media-telemetry-defaults",
        snap.screenFramesWindowRejected == 0L &&
            snap.screenFramesSocketRejected == 0L &&
            snap.screenAudioFramesSent == 0L &&
            snap.screenAudioFramesDropped == 0L &&
            snap.callAudioFramesSent == 0L &&
            snap.callAudioFramesReceived == 0L,
    )

    println("ScreenFramerateAndAudioContinuityTest: $passed passed, $failed failed")
    if (failed > 0) exitProcess(1)
}
