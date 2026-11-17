package com.airbridge.engine

import java.util.Collections
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.spec.SecretKeySpec
import kotlin.system.exitProcess

/**
 * Phone-side continuity channel checks with an in-memory host: authorization,
 * contacts and call commands, consent, credit-based screen flow control and
 * cleanup. (The live Kotlin ↔ TypeScript path runs in ContinuityE2E.kt.)
 */
private var continuityFailed = 0
private var continuityPassed = 0

private fun expect(name: String, ok: Boolean, detail: String = "") {
    if (ok) continuityPassed++ else {
        continuityFailed++
        println("FAIL $name $detail")
    }
}

private class FakeContinuityHost : ContinuityChannel.Host {
    val sent: MutableList<Pair<String, JsonValue.Obj>> = Collections.synchronizedList(mutableListOf())
    val frames: MutableList<Pair<String, ByteArray>> = Collections.synchronizedList(mutableListOf())
    val scheduled = mutableListOf<Pair<Long, () -> Unit>>()
    val listeners = CopyOnWriteArrayList<EngineListener>()
    val peers = linkedMapOf<String, Peer>()
    val authorized = mutableSetOf<String>()
    var frameSocketOpen = true
    val key = SecretKeySpec(ByteArray(32) { 0x22 }, "AES")

    override fun sendControl(peerId: String, payload: JsonValue.Obj) { sent.add(peerId to payload) }
    override fun sendFrame(peerId: String, innerFrame: ByteArray): Boolean {
        if (!frameSocketOpen) return false
        frames.add(peerId to innerFrame)
        return true
    }
    override fun sessionKey(peerId: String) = if (peers.containsKey(peerId)) key else null
    override fun peer(peerId: String) = peers[peerId]
    override fun isAuthorized(peerId: String) = peerId in authorized && peers[peerId]?.discoveryScope == "paired"
    override fun isPaired(peerId: String) = peers[peerId]?.discoveryScope == "paired"
    override fun peerIds() = peers.keys.toList()
    override fun execute(task: () -> Unit) = task()
    override fun schedule(delayMs: Long, task: () -> Unit) { scheduled.add(delayMs to task) }
    override fun listeners(): Iterable<EngineListener> = listeners

    fun last(kind: String) = sent.lastOrNull { it.second.optStr("kind") == kind }
}

private fun peer(id: String, scope: String = "paired", key: String = "key-$id") =
    Peer(id, DeviceProfile(name = "Mac $id", platform = "macos", model = "MacBook", formFactor = "laptop", publicKey = key), scope, 0L, verified = true)

private fun obj(vararg pairs: Pair<String, Any?>): JsonValue.Obj {
    val o = JsonValue.Obj()
    for ((k, v) in pairs) when (v) {
        is String -> o.put(k, v)
        is Int -> o.put(k, v)
        is Long -> o.put(k, v)
        is Boolean -> o.put(k, v)
        is JsonValue -> o.put(k, v)
        null -> {}
    }
    return o
}

fun main() {
    val mac = "aaaaaaaaaaaaaaaa"
    val stranger = "bbbbbbbbbbbbbbbb"
    val host = FakeContinuityHost()
    val channel = ContinuityChannel(host)
    val requests = mutableListOf<ScreenShareRequest>()
    val ended = mutableListOf<Pair<String, String>>()
    val cards = mutableListOf<ContactShareItem>()
    host.listeners.add(object : EngineListener {
        override fun onScreenShareRequest(request: ScreenShareRequest) { requests.add(request) }
        override fun onScreenShareEnded(sessionId: String, reason: String) { ended.add(sessionId to reason) }
        override fun onContactsReceived(item: ContactShareItem) { cards.add(item) }
    })
    host.peers[mac] = peer(mac)
    host.peers[stranger] = peer(stranger, scope = "nearby")
    host.authorized.add(mac)

    // ---- features + announce ------------------------------------------------
    expect("features.default", channel.features() == listOf("contacts.receive"))
    channel.contactProvider = ContactProvider { q, limit ->
        listOf(
            ContactCard("Ada Lovelace", listOf(ContactPhone("+44 20 7946 0958", "mobile"))),
            ContactCard("Alan Turing", listOf(ContactPhone("+44 161 496 0000", "work")), organization = "Bletchley"),
            ContactCard("", listOf(ContactPhone("javascript:alert(1)"))), // dropped by sanitize
        ).filter { Continuity.contactMatches(it, q) }.take(limit)
    }
    expect("features.provider-not-ready", !channel.features().contains("contacts.provide"))
    channel.contactsReady = true
    val commands = mutableListOf<CallCommand>()
    channel.callController = CallController { cmd -> commands.add(cmd); CallCommandResult(true) }
    channel.callsReady = true
    channel.screenSourceAvailable = true
    expect("features.all", channel.features() == listOf("contacts.receive", "contacts.provide", "calls.control", "screen.source"))
    channel.onPeersChanged(host.peers.values.toList())
    val hellos = host.sent.filter { it.second.optStr("kind") == "continuity-hello" }
    expect("announce.paired-only", hellos.map { it.first } == listOf(mac), "got ${hellos.map { it.first }}")
    expect("announce.retry-scheduled", host.scheduled.any { it.first == 2_000L })
    host.sent.clear()
    channel.handleControl(mac, obj("kind" to "continuity-hello", "v" to 1, "features" to JsonValue.JsonArr(mutableListOf(JsonValue.JsonStr("screen.view"), JsonValue.JsonStr("bogus")))))
    expect("hello.recorded", channel.peerFeatures(mac) == listOf("screen.view"))
    expect("hello.answered-once", host.sent.count { it.second.optStr("kind") == "continuity-hello" } == 1)
    channel.handleControl(mac, obj("kind" to "continuity-hello", "v" to 1, "features" to JsonValue.JsonArr()))
    expect("hello.not-answered-twice", host.sent.count { it.second.optStr("kind") == "continuity-hello" } == 1)
    channel.handleControl(stranger, obj("kind" to "continuity-hello", "v" to 1, "features" to JsonValue.JsonArr()))
    expect("hello.stranger-ignored", channel.peerFeatures(stranger).isEmpty() && host.sent.none { it.first == stranger })

    // ---- contacts -----------------------------------------------------------
    channel.handleControl(mac, obj("kind" to "contacts-request", "requestId" to "0123456789abcdef", "query" to "al", "limit" to 10))
    val resp = host.last("contacts-response")!!.second
    val names = resp.optArr("contacts")!!.items.map { it.asObj().optStr("name") }
    expect("contacts.query", names == listOf("Alan Turing"), "got $names")
    expect("contacts.shape", resp.optLong("total") == 1L && resp.optBool("truncated") == false &&
        resp.optArr("contacts")!!.items[0].asObj().optStr("organization") == "Bletchley")
    channel.handleControl(mac, obj("kind" to "contacts-request", "requestId" to "0123456789abcde0", "limit" to 1))
    val page = host.last("contacts-response")!!.second
    expect("contacts.truncated", page.optArr("contacts")!!.items.size == 1 && page.optBool("truncated") == true && page.optLong("total") == 2L)
    channel.handleControl(stranger, obj("kind" to "contacts-request", "requestId" to "0123456789abcde1"))
    expect("contacts.unauthorized", host.last("contacts-response")!!.let { it.first == stranger && it.second.optStr("error") == "unauthorized" })
    channel.handleControl(mac, obj("kind" to "contacts-request", "requestId" to "nothex"))
    expect("contacts.bad-id-ignored", host.last("contacts-response")!!.second.optStr("requestId") == "0123456789abcde1")
    channel.contactsReady = false
    channel.handleControl(mac, obj("kind" to "contacts-request", "requestId" to "0123456789abcde4"))
    expect("contacts.disabled", host.last("contacts-response")!!.second.optStr("error") == "disabled")
    channel.contactsReady = true
    channel.contactProvider = ContactProvider { _, _ -> throw ContinuityException("permission", "Contacts permission not granted") }
    channel.handleControl(mac, obj("kind" to "contacts-request", "requestId" to "0123456789abcde2"))
    expect("contacts.permission", host.last("contacts-response")!!.second.optStr("error") == "permission")
    channel.contactProvider = ContactProvider { _, _ -> throw IllegalStateException("db locked") }
    channel.handleControl(mac, obj("kind" to "contacts-request", "requestId" to "0123456789abcde3"))
    expect("contacts.failed", host.last("contacts-response")!!.second.let { it.optStr("error") == "failed" && it.optStr("message") == "db locked" })

    // ---- contact cards --------------------------------------------------------
    val vcard = VCard.build(ContactCard("Dr. Who", listOf(ContactPhone("+44 7700 900123", "mobile"))))
    channel.handleControl(mac, obj("kind" to "contact-share", "shareId" to "0123456789abcdef", "vcard" to vcard, "timestamp" to 1L))
    channel.handleControl(mac, obj("kind" to "contact-share", "shareId" to "0123456789abcdef", "vcard" to vcard, "timestamp" to 1L))
    channel.handleControl(stranger, obj("kind" to "contact-share", "shareId" to "0123456789abcdee", "vcard" to vcard, "timestamp" to 1L))
    expect("cards.received-once", cards.size == 1 && cards[0].contacts[0].name == "Dr. Who" && cards[0].peerName == "Mac $mac")
    val out = channel.shareContacts(mac, listOf(ContactCard("Ada", emails = listOf(ContactEmail("ada@example.org")))))
    expect("cards.sent", host.last("contact-share")!!.second.optStr("vcard") == out.vcard && out.vcard.contains("EMAIL;TYPE=INTERNET:ada@example.org"))

    // ---- calls ----------------------------------------------------------------
    host.sent.clear()
    channel.publishCallState(CallInfo("0123456789abcdef", "ringing", "incoming", number = "+1 555 0100", updatedAt = 1, actions = listOf("answer", "reject")))
    expect("calls.published-to-authorized", host.sent.map { it.first } == listOf(mac))
    expect("calls.payload", host.sent[0].second.optObj("call")!!.optStr("number") == "+1 555 0100")
    channel.handleControl(mac, obj("kind" to "call-command", "commandId" to "1111111111111111", "action" to "answer", "callId" to "0123456789abcdef"))
    expect("calls.answer", commands.lastOrNull() == CallCommand(mac, "answer", callId = "0123456789abcdef") &&
        host.last("call-command-result")!!.second.optBool("ok") == true)
    channel.handleControl(mac, obj("kind" to "call-command", "commandId" to "2222222222222222", "action" to "dial", "number" to "+1 (202) 555-0143"))
    expect("calls.dial-sanitized", commands.lastOrNull()?.number == "+12025550143")
    channel.handleControl(mac, obj("kind" to "call-command", "commandId" to "3333333333333333", "action" to "dial", "number" to "rm -rf"))
    expect("calls.dial-invalid", host.last("call-command-result")!!.second.let { it.optBool("ok") == false && it.optStr("error") == "Invalid phone number." })
    channel.handleControl(mac, obj("kind" to "call-command", "commandId" to "4444444444444444", "action" to "explode"))
    expect("calls.unknown-action", host.last("call-command-result")!!.second.optStr("error") == "Unknown call action.")
    val before = commands.size
    channel.handleControl(stranger, obj("kind" to "call-command", "commandId" to "5555555555555555", "action" to "dial", "number" to "123"))
    expect("calls.unauthorized", commands.size == before && host.last("call-command-result")!!.first == stranger)
    channel.callsReady = false
    channel.handleControl(mac, obj("kind" to "call-command", "commandId" to "6666666666666666", "action" to "hangup", "callId" to "0123456789abcdef"))
    expect("calls.not-ready", commands.size == before && host.last("call-command-result")!!.second.optStr("error")!!.contains("Allow phone access"))
    channel.callsReady = true

    // ---- screen sharing -------------------------------------------------------
    val sid = "a1b2c3d4e5f60718"
    channel.handleControl(stranger, obj("kind" to "screen-share-request", "sessionId" to "a1b2c3d4e5f60719"))
    expect("screen.unauthorized", requests.isEmpty() && host.last("screen-share-state")!!.second.optStr("state") == "declined")
    channel.handleControl(mac, obj("kind" to "screen-share-request", "sessionId" to sid, "maxWidth" to 99999, "maxFps" to 60))
    expect("screen.request", requests.singleOrNull()?.let { it.sessionId == sid && it.maxWidth == 2560 && it.maxFps == 30 } == true)
    expect("screen.pending-sent", host.last("screen-share-state")!!.second.optStr("state") == "pending")
    expect("screen.no-frames-before-consent", !channel.sendScreenFrame(sid, byteArrayOf(1, 2, 3), 100, 200))
    expect("screen.accept", channel.acceptScreenShare(sid)?.peerId == mac && host.last("screen-share-state")!!.second.optStr("state") == "active")
    expect("screen.active", channel.isScreenShareActive(sid) && channel.screenQuality(sid) == 70)
    val jpeg = ByteArray(5000) { (it % 251).toByte() }
    expect("screen.frame1", channel.sendScreenFrame(sid, jpeg, 1080, 2400))
    expect("screen.interval", !channel.canSendScreenFrame(sid)) // 30 fps → 33 ms between frames
    Thread.sleep(40)
    expect("screen.frame2", channel.sendScreenFrame(sid, jpeg, 1080, 2400))
    Thread.sleep(40)
    expect("screen.window-full", !channel.canSendScreenFrame(sid) && !channel.sendScreenFrame(sid, jpeg, 1080, 2400))
    val first = Continuity.decodeScreenFrame(host.frames[0].second)
    expect("screen.frame-header", first.sessionId == sid && first.seq == 1L && first.width == 1080 && first.height == 2400 && first.codec == 1)
    expect("screen.frame-opens", AirCrypto.decryptMediaFrame(host.key, first.aad, first.iv, first.ciphertext).contentEquals(jpeg))
    channel.handleControl(stranger, obj("kind" to "screen-share-ack", "sessionId" to sid, "seq" to 2L))
    expect("screen.ack-from-stranger-ignored", !channel.canSendScreenFrame(sid))
    channel.handleControl(mac, obj("kind" to "screen-share-ack", "sessionId" to sid, "seq" to 9L))
    expect("screen.ack-future-ignored", !channel.canSendScreenFrame(sid))
    channel.handleControl(mac, obj("kind" to "screen-share-ack", "sessionId" to sid, "seq" to 2L))
    expect("screen.ack-opens-window", channel.canSendScreenFrame(sid) && channel.screenQuality(sid) == 72)
    host.frameSocketOpen = false
    val framesBefore = host.frames.size
    expect("screen.socket-busy-drops", !channel.sendScreenFrame(sid, jpeg, 1080, 2400) && host.frames.size == framesBefore)
    host.frameSocketOpen = true
    Thread.sleep(40) // a busy socket still paces the next attempt by one frame interval
    expect("screen.after-busy", channel.sendScreenFrame(sid, jpeg, 1080, 2400) && Continuity.decodeScreenFrame(host.frames.last().second).seq == 3L)
    expect("screen.oversize-dropped", !channel.sendScreenFrame(sid, ByteArray(Continuity.SCREEN_MAX_FRAME_BYTES + 1), 10, 10))
    channel.handleControl(mac, obj("kind" to "screen-share-stop", "sessionId" to sid))
    expect("screen.viewer-stop", !channel.isScreenShareActive(sid) && ended.lastOrNull()?.first == sid)

    // consent timeout and decline
    val sid2 = "a1b2c3d4e5f6071a"
    channel.handleControl(mac, obj("kind" to "screen-share-request", "sessionId" to sid2))
    val timeout = host.scheduled.last { it.first == Continuity.SCREEN_CONSENT_TIMEOUT_MS }
    timeout.second()
    expect("screen.timeout", channel.pendingScreenRequests().isEmpty() && host.last("screen-share-state")!!.second.optStr("reason") == "The request timed out.")
    expect("screen.accept-after-timeout", channel.acceptScreenShare(sid2) == null)
    val sid3 = "a1b2c3d4e5f6071b"
    channel.handleControl(mac, obj("kind" to "screen-share-request", "sessionId" to sid3))
    channel.declineScreenShare(sid3, "Not now")
    expect("screen.decline", host.last("screen-share-state")!!.second.let { it.optStr("state") == "declined" && it.optStr("reason") == "Not now" })
    channel.screenSourceAvailable = false
    channel.handleControl(mac, obj("kind" to "screen-share-request", "sessionId" to "a1b2c3d4e5f6071c"))
    expect("screen.unsupported", host.last("screen-share-state")!!.second.optStr("state") == "unsupported")
    channel.screenSourceAvailable = true

    // disconnect cleans up sessions
    val sid4 = "a1b2c3d4e5f6071d"
    channel.handleControl(mac, obj("kind" to "screen-share-request", "sessionId" to sid4))
    channel.acceptScreenShare(sid4)
    host.peers.remove(mac)
    channel.onPeersChanged(host.peers.values.toList())
    expect("disconnect.cleanup", !channel.isScreenShareActive(sid4) && ended.last() == (sid4 to "The computer disconnected") && channel.peerFeatures(mac).isEmpty())
    expect("unknown-kind-not-handled", !channel.handleControl(mac, obj("kind" to "transfer-offer")))

    if (continuityFailed > 0) {
        println("CONTINUITY: $continuityFailed FAILED, $continuityPassed passed")
        exitProcess(1)
    }
    println("CONTINUITY: ALL PASS ($continuityPassed checks)")
}
