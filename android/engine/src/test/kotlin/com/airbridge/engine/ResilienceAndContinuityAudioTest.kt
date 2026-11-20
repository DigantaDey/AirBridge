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

private class AudioHost : ContinuityChannel.Host {
    val sent = Collections.synchronizedList(mutableListOf<Pair<String, JsonValue.Obj>>())
    val frames = Collections.synchronizedList(mutableListOf<Pair<String, ByteArray>>())
    val listeners = CopyOnWriteArrayList<EngineListener>()
    val peers = linkedMapOf<String, Peer>()
    val authorized = mutableSetOf<String>()
    val key = SecretKeySpec(ByteArray(32) { 0x44 }, "AES")

    override fun sendControl(peerId: String, payload: JsonValue.Obj) { sent.add(peerId to payload) }
    override fun sendFrame(peerId: String, innerFrame: ByteArray): Boolean {
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
    val stranger = "bbbbbbbbbbbbbbbb"
    val callId = "0123456789abcdef"

    // 1. CallAudio codec round-trip & tamper rejection
    val pcm = ByteArray(Continuity.CALL_AUDIO_FRAME_SAMPLES * 2) { (it and 0xff).toByte() }
    val aad = Continuity.encodeCallAudioAad(callId, 7L, Continuity.CALL_AUDIO_SAMPLE_RATE, 1, Continuity.CALL_AUDIO_FRAME_SAMPLES, 120L)
    val key = SecretKeySpec(ByteArray(32) { 0x19 }, "AES")
    val (iv, ct) = AirCrypto.encryptMediaFrame(key, aad, pcm)
    val encoded = Continuity.encodeCallAudioFrame(aad, iv, ct)
    expect("call-audio.frame-byte", (encoded[0].toInt() and 0xff) == Continuity.FRAME_CALL_AUDIO)
    val decoded = Continuity.decodeCallAudioFrame(encoded)
    expect("call-audio.header-fields", decoded.callId == callId && decoded.seq == 7L && decoded.sampleRate == 16_000 && decoded.ptsMs == 120L)
    val decrypted = AirCrypto.decryptMediaFrame(key, decoded.aad, decoded.iv, decoded.ciphertext)
    expect("call-audio.plaintext-match", decrypted.contentEquals(pcm))

    val tampered = encoded.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0xff).toByte() }
    val tamperRejected = runCatching {
        val d = Continuity.decodeCallAudioFrame(tampered)
        AirCrypto.decryptMediaFrame(key, d.aad, d.iv, d.ciphertext)
    }.isFailure
    expect("call-audio.tamper-rejected", tamperRejected)

    // 2. ContinuityChannel call audio control, anti-replay, and PLI keyframe requests
    val host = AudioHost()
    host.peers[mac] = Peer(mac, DeviceProfile("MacBook", "macos", "MacBook", "laptop", "pk-mac"), "paired", 1L, verified = true)
    host.peers[stranger] = Peer(stranger, DeviceProfile("Stranger", "macos", "Mac", "laptop", "pk-stranger"), "nearby", 1L, verified = false)
    host.authorized.add(mac)

    val channel = ContinuityChannel(host)
    channel.callsReady = true
    channel.callController = CallController { CallCommandResult(true) }
    val audioCommands = mutableListOf<CallAudioCommand>()
    val incomingAudio = mutableListOf<CallAudioFrame>()
    channel.callAudioController = object : CallAudioController {
        override fun execute(command: CallAudioCommand): CallAudioState {
            audioCommands.add(command)
            return CallAudioState(active = command.action != "stop", muted = command.action == "mute", route = if (command.action == "stop") "phone" else "computer")
        }
        override fun onIncomingAudio(frame: CallAudioFrame) {
            incomingAudio.add(frame)
        }
    }
    expect("features.calls-audio-present", channel.features().contains(Continuity.FEATURE_CALLS_AUDIO))

    // Unauthorized control rejected
    channel.handleControl(stranger, JsonValue.Obj().put("kind", "call-audio-control").put("callId", callId).put("action", "start"))
    val strangerState = host.sent.lastOrNull()?.second
    expect("call-audio.stranger-denied", strangerState?.optStr("kind") == "call-audio-state" && strangerState.optBool("active") == false)
    expect("call-audio.stranger-no-command", audioCommands.isEmpty())

    // Authorized start + anti-replay frame handling
    channel.handleControl(mac, JsonValue.Obj().put("kind", "call-audio-control").put("callId", callId).put("action", "start").put("sampleRate", 16_000))
    expect("call-audio.start-executed", audioCommands.lastOrNull()?.action == "start")
    val macState = host.sent.lastOrNull()?.second
    expect("call-audio.state-computer", macState?.optBool("active") == true && macState.optStr("route") == "computer")

    val inAad1 = Continuity.encodeCallAudioAad(callId, 1L, 16_000, 1, 320, 0L)
    val (inIv1, inCt1) = AirCrypto.encryptMediaFrame(host.key, inAad1, pcm)
    val inFrame1 = Continuity.encodeCallAudioFrame(inAad1, inIv1, inCt1)
    channel.handleMediaFrame(mac, inFrame1)
    channel.handleMediaFrame(mac, inFrame1) // duplicate replay must drop
    expect("call-audio.anti-replay", incomingAudio.size == 1 && channel.callAudioFramesReceivedCount.get() == 1L)

    // Outgoing phone audio packet
    expect("call-audio.send-frame", channel.sendCallAudio(mac, callId, pcm, 16_000, 1, 320, 20L))
    expect("call-audio.sent-counter", channel.callAudioFramesSentCount.get() == 1L && host.frames.size == 1)

    // Screen keyframe PLI dispatch for owned session only
    channel.screenSourceAvailable = true
    val pliSessions = mutableListOf<String>()
    channel.screenKeyframeRequester = ScreenKeyframeRequester { id, _ -> pliSessions.add(id) }
    val sid = "fedcba9876543210"
    channel.handleControl(mac, JsonValue.Obj().put("kind", "screen-share-request").put("sessionId", sid).put("maxWidth", 1280).put("maxFps", 30))
    channel.acceptScreenShare(sid)
    channel.handleControl(mac, JsonValue.Obj().put("kind", "screen-share-keyframe").put("sessionId", sid).put("reason", "stall"))
    expect("screen.pli-dispatched", pliSessions == listOf(sid) && channel.screenPliReceivedCount.get() == 1L)
    expect("screen.can-send-keyframe-burst", channel.canSendScreenFrame(sid, keyFrame = true))

    // 3. Engine diagnostics snapshot defaults for new fields
    val engine = AirBridgeEngine(EngineConfig(serverUrl = "ws://127.0.0.1:0", deviceName = "TestPhone"))
    val snap = engine.diagnosticsSnapshot()
    expect("engine.diag-fields", snap.transferResumes == 0L && snap.transferInterruptions == 0L && snap.outboundBatchFlushes == 0L)

    println("ResilienceAndContinuityAudioTest: $passed passed, $failed failed")
    if (failed > 0) exitProcess(1)
}
