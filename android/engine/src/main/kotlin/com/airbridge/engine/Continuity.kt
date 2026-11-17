package com.airbridge.engine

import java.nio.charset.StandardCharsets
import java.text.Normalizer
import javax.crypto.spec.SecretKeySpec

// =============================================================================
// Phone continuity — contacts, calls and screen sharing with paired computers.
// Byte-for-byte port of src/shared/continuity.ts (cross-checked by vectors.json)
// plus the phone-side channel. See docs/continuity.md.
// =============================================================================

data class ContactPhone(val number: String, val label: String? = null)

data class ContactEmail(val address: String, val label: String? = null)

data class ContactCard(
    val name: String,
    val phones: List<ContactPhone> = emptyList(),
    val emails: List<ContactEmail> = emptyList(),
    val organization: String? = null,
    val note: String? = null,
    val id: String? = null,
    val starred: Boolean = false,
) {
    fun toJson(): JsonValue.Obj {
        val o = JsonValue.Obj()
        if (id != null) o.put("id", id)
        o.put("name", name)
        o.put("phones", JsonValue.JsonArr(phones.map { p ->
            JsonValue.Obj().put("number", p.number).putOpt("label", p.label) as JsonValue
        }.toMutableList()))
        o.put("emails", JsonValue.JsonArr(emails.map { e ->
            JsonValue.Obj().put("address", e.address).putOpt("label", e.label) as JsonValue
        }.toMutableList()))
        o.putOpt("organization", organization)
        o.putOpt("note", note)
        if (starred) o.put("starred", true)
        return o
    }
}

/** A call as reported to computers. [state]: ringing | dialing | active | held | ended. */
data class CallInfo(
    val callId: String,
    val state: String,
    val direction: String,
    val number: String? = null,
    val name: String? = null,
    val connectedAt: Long? = null,
    val updatedAt: Long = System.currentTimeMillis(),
    val actions: List<String> = emptyList(),
    val audioRoute: String? = null,
) {
    fun toJson(): JsonValue.Obj {
        val o = JsonValue.Obj()
            .put("callId", callId)
            .put("state", state)
            .put("direction", direction)
            .putOpt("number", number)
            .putOpt("name", name)
            .putOpt("connectedAt", connectedAt)
            .put("updatedAt", updatedAt)
            .put("actions", JsonValue.JsonArr(actions.map { JsonValue.JsonStr(it) as JsonValue }.toMutableList()))
        o.putOpt("audioRoute", audioRoute)
        return o
    }
}

data class CallCommand(val peerId: String, val action: String, val callId: String? = null, val number: String? = null)

data class CallCommandResult(val ok: Boolean, val error: String? = null, val callId: String? = null)

data class ContactShareItem(
    val shareId: String,
    val peerId: String,
    val peerName: String,
    val contacts: List<ContactCard>,
    val vcard: String,
    val timestamp: Long,
)

data class ScreenShareRequest(
    val sessionId: String,
    val peerId: String,
    val peerName: String,
    val maxWidth: Int,
    val maxFps: Int,
    val requestedAt: Long,
)

/** Answers contacts-request; throw [ContinuityException] with code disabled | permission | failed. */
fun interface ContactProvider {
    fun query(query: String, limit: Int): List<ContactCard>
}

/** Executes answer / reject / hangup / dial on the phone. */
fun interface CallController {
    fun execute(command: CallCommand): CallCommandResult
}

class ContinuityException(val code: String, message: String) : Exception(message)

object Continuity {
    const val PROTOCOL_VERSION = 1
    const val FEATURE_CONTACTS_PROVIDE = "contacts.provide"
    const val FEATURE_CONTACTS_RECEIVE = "contacts.receive"
    const val FEATURE_CALLS_CONTROL = "calls.control"
    const val FEATURE_SCREEN_SOURCE = "screen.source"
    const val FEATURE_SCREEN_VIEW = "screen.view"
    val FEATURES = listOf(FEATURE_CONTACTS_PROVIDE, FEATURE_CONTACTS_RECEIVE, FEATURE_CALLS_CONTROL, FEATURE_SCREEN_SOURCE, FEATURE_SCREEN_VIEW)

    const val MAX_CONTACTS_PER_RESPONSE = 5000
    const val DEFAULT_CONTACTS_LIMIT = 2000
    const val MAX_CONTACT_FIELD = 256
    const val MAX_CONTACT_NOTE = 2000
    const val MAX_CONTACT_VALUES = 20
    const val MAX_VCARD_LENGTH = 64 * 1024
    const val MAX_CONTACT_QUERY = 100

    val CALL_STATES = listOf("ringing", "dialing", "active", "held", "ended")
    val CALL_ACTIONS = listOf("answer", "reject", "hangup", "dial")

    const val SCREEN_CODEC_JPEG = 1
    const val SCREEN_DEFAULT_MAX_WIDTH = 1280
    const val SCREEN_MAX_WIDTH_LIMIT = 2560
    const val SCREEN_DEFAULT_FPS = 15
    const val SCREEN_MAX_FPS = 30
    const val SCREEN_MAX_INFLIGHT = 2
    const val SCREEN_MAX_FRAME_BYTES = 3 * 1024 * 1024
    const val SCREEN_CONSENT_TIMEOUT_MS = 2 * 60_000L
    const val FRAME_SCREEN = 0x04
    const val SCREEN_FRAME_AAD_LENGTH = 1 + 16 + 4 + 1 + 2 + 2 // 26
    const val SCREEN_FRAME_HEADER_LENGTH = SCREEN_FRAME_AAD_LENGTH + 12 // 38

    private val ID = Regex("^[0-9a-f]{16}$")
    private val PHONE_ALLOWED = Regex("^[+0-9*#()\\-.,;/ pwPW]{1,64}$")
    private val CONTROL_CHARS = Regex("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]")
    private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+$")

    fun isId(value: String?): Boolean = value != null && ID.matches(value)

    internal fun cleanText(value: String?, max: Int): String? {
        if (value == null) return null
        val cleaned = value.replace(CONTROL_CHARS, "").trim()
        if (cleaned.isEmpty()) return null
        return if (cleaned.length > max) cleaned.substring(0, max) else cleaned
    }

    fun sanitizePhoneNumber(value: String?): String? {
        val text = cleanText(value, 64) ?: return null
        if (!PHONE_ALLOWED.matches(text)) return null
        return if (text.any { it in '0'..'9' }) text else null
    }

    fun dialableNumber(value: String?): String? {
        val text = sanitizePhoneNumber(value) ?: return null
        val sb = StringBuilder()
        for (c in text) {
            if (c in '0'..'9' || c == '*' || c == '#' || c == ',' || c == ';') sb.append(c)
            else if (c == '+' && sb.isEmpty()) sb.append(c)
        }
        val dial = sb.toString()
        return if (dial.any { it in '0'..'9' } && dial.length <= 40) dial else null
    }

    fun sanitizeContact(card: ContactCard): ContactCard? = sanitizeContactFields(
        card.name, card.phones, card.emails, card.organization, card.note, card.id, card.starred,
    )

    fun sanitizeContact(o: JsonValue.Obj): ContactCard? {
        val phones = o.optArr("phones")?.items?.mapNotNull { (it as? JsonValue.Obj)?.let { p -> ContactPhone(p.optStr("number") ?: "", p.optStr("label")) } } ?: emptyList()
        val emails = o.optArr("emails")?.items?.mapNotNull { (it as? JsonValue.Obj)?.let { e -> ContactEmail(e.optStr("address") ?: "", e.optStr("label")) } } ?: emptyList()
        return sanitizeContactFields(o.optStr("name"), phones, emails, o.optStr("organization"), o.optStr("note"), o.optStr("id"), o.optBool("starred") == true)
    }

    private fun sanitizeContactFields(
        rawName: String?, rawPhones: List<ContactPhone>, rawEmails: List<ContactEmail>,
        organization: String?, note: String?, id: String?, starred: Boolean,
    ): ContactCard? {
        val phones = rawPhones.take(MAX_CONTACT_VALUES).mapNotNull { p ->
            sanitizePhoneNumber(p.number)?.let { ContactPhone(it, cleanText(p.label, 40)) }
        }
        val emails = rawEmails.take(MAX_CONTACT_VALUES).mapNotNull { e ->
            cleanText(e.address, MAX_CONTACT_FIELD)?.takeIf { EMAIL.matches(it) }?.let { ContactEmail(it, cleanText(e.label, 40)) }
        }
        val name = cleanText(rawName, MAX_CONTACT_FIELD) ?: phones.firstOrNull()?.number ?: emails.firstOrNull()?.address ?: return null
        return ContactCard(
            name = name, phones = phones, emails = emails,
            organization = cleanText(organization, MAX_CONTACT_FIELD),
            note = cleanText(note, MAX_CONTACT_NOTE),
            id = cleanText(id, 128),
            starred = starred,
        )
    }

    private fun normalizeForSearch(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFKD).replace(Regex("[\\u0300-\\u036f]"), "").lowercase().trim()

    fun contactMatches(card: ContactCard, query: String): Boolean {
        val q = normalizeForSearch(query)
        if (q.isEmpty()) return true
        if (normalizeForSearch(card.name).contains(q)) return true
        if (card.organization != null && normalizeForSearch(card.organization).contains(q)) return true
        if (card.emails.any { it.address.lowercase().contains(q) }) return true
        val digits = query.filter { it in '0'..'9' }
        return digits.length >= 3 && card.phones.any { p -> p.number.filter { it in '0'..'9' }.contains(digits) }
    }

    fun sanitizeCall(o: JsonValue.Obj, now: Long = System.currentTimeMillis()): CallInfo? {
        val callId = o.optStr("callId")?.takeIf { isId(it) } ?: return null
        val state = o.optStr("state")?.takeIf { it in CALL_STATES } ?: return null
        val actions = o.optArr("actions")?.items?.mapNotNull { it.asStringOrNull()?.takeIf { a -> a in CALL_ACTIONS } }?.distinct() ?: emptyList()
        val route = o.optStr("audioRoute")?.takeIf { it in listOf("phone", "speaker", "headset", "bluetooth") }
        return CallInfo(
            callId = callId,
            state = state,
            direction = if (o.optStr("direction") == "outgoing") "outgoing" else "incoming",
            number = sanitizePhoneNumber(o.optStr("number")),
            name = cleanText(o.optStr("name"), MAX_CONTACT_FIELD),
            connectedAt = o.optLong("connectedAt")?.takeIf { it > 0 },
            updatedAt = o.optLong("updatedAt") ?: now,
            actions = actions,
            audioRoute = route,
        )
    }

    fun sanitizeCall(call: CallInfo): CallInfo? = sanitizeCall(call.toJson(), call.updatedAt)

    fun clampScreen(maxWidth: Long?, maxFps: Long?): Pair<Int, Int> {
        val w = (maxWidth ?: SCREEN_DEFAULT_MAX_WIDTH.toLong()).coerceIn(320, SCREEN_MAX_WIDTH_LIMIT.toLong()).toInt()
        val f = (maxFps ?: SCREEN_DEFAULT_FPS.toLong()).coerceIn(1, SCREEN_MAX_FPS.toLong()).toInt()
        return w to f
    }

    /** AIMD quality from ack round-trip time; identical to nextScreenQuality in TS. */
    fun nextQuality(current: Double, ackRttMs: Long): Double {
        val next = when {
            ackRttMs > 400 -> current * 0.75
            ackRttMs > 200 -> current - 0.05
            else -> current + 0.02
        }
        return Math.round(next.coerceIn(0.3, 0.85) * 100).toDouble() / 100
    }

    fun encodeScreenAad(sessionId: String, seq: Long, codec: Int, width: Int, height: Int): ByteArray {
        require(isId(sessionId)) { "Invalid screen session id" }
        require(seq in 0..0xffffffffL) { "Invalid frame sequence" }
        require(width in 1..0xffff && height in 1..0xffff) { "Invalid frame size" }
        val out = ByteArray(SCREEN_FRAME_AAD_LENGTH)
        out[0] = FRAME_SCREEN.toByte()
        for (i in 0 until 16) out[1 + i] = sessionId[i].code.toByte()
        out[17] = (seq ushr 24).toByte(); out[18] = (seq ushr 16).toByte(); out[19] = (seq ushr 8).toByte(); out[20] = seq.toByte()
        out[21] = codec.toByte()
        out[22] = (width ushr 8).toByte(); out[23] = width.toByte()
        out[24] = (height ushr 8).toByte(); out[25] = height.toByte()
        return out
    }

    fun encodeScreenFrame(aad: ByteArray, iv: ByteArray, ciphertext: ByteArray): ByteArray {
        require(aad.size == SCREEN_FRAME_AAD_LENGTH && (aad[0].toInt() and 0xff) == FRAME_SCREEN) { "Invalid screen frame header" }
        require(iv.size == 12) { "Invalid IV length" }
        val out = ByteArray(SCREEN_FRAME_HEADER_LENGTH + ciphertext.size)
        System.arraycopy(aad, 0, out, 0, aad.size)
        System.arraycopy(iv, 0, out, SCREEN_FRAME_AAD_LENGTH, 12)
        System.arraycopy(ciphertext, 0, out, SCREEN_FRAME_HEADER_LENGTH, ciphertext.size)
        return out
    }

    class DecodedScreenFrame(
        val sessionId: String, val seq: Long, val codec: Int, val width: Int, val height: Int,
        val aad: ByteArray, val iv: ByteArray, val ciphertext: ByteArray,
    )

    fun decodeScreenFrame(bytes: ByteArray): DecodedScreenFrame {
        require(bytes.size >= SCREEN_FRAME_HEADER_LENGTH + 16) { "Screen frame too short" }
        require((bytes[0].toInt() and 0xff) == FRAME_SCREEN) { "Not a screen frame" }
        require(bytes.size <= SCREEN_FRAME_HEADER_LENGTH + SCREEN_MAX_FRAME_BYTES + 16) { "Screen frame too large" }
        val sessionId = String(bytes, 1, 16, StandardCharsets.ISO_8859_1)
        require(isId(sessionId)) { "Invalid screen session id" }
        fun u(i: Int) = bytes[i].toInt() and 0xff
        val seq = (u(17).toLong() shl 24) or (u(18).toLong() shl 16) or (u(19).toLong() shl 8) or u(20).toLong()
        val width = (u(22) shl 8) or u(23)
        val height = (u(24) shl 8) or u(25)
        require(width > 0 && height > 0) { "Invalid frame size" }
        return DecodedScreenFrame(
            sessionId, seq, u(21), width, height,
            bytes.copyOfRange(0, SCREEN_FRAME_AAD_LENGTH),
            bytes.copyOfRange(SCREEN_FRAME_AAD_LENGTH, SCREEN_FRAME_HEADER_LENGTH),
            bytes.copyOfRange(SCREEN_FRAME_HEADER_LENGTH, bytes.size),
        )
    }
}

/** vCard 3.0 writer and 2.1/3.0/4.0 reader; mirrors buildVCard/parseVCards in TS. */
object VCard {
    private val PHONE_TYPE_TO_LABEL = mapOf(
        "CELL" to "mobile", "MOBILE" to "mobile", "IPHONE" to "mobile", "HOME" to "home", "WORK" to "work",
        "MAIN" to "main", "FAX" to "fax", "PAGER" to "pager", "OTHER" to "other", "VOICE" to "other",
    )
    private val LABEL_TO_PHONE_TYPE = mapOf(
        "mobile" to "CELL", "home" to "HOME", "work" to "WORK", "main" to "MAIN", "fax" to "FAX", "pager" to "PAGER", "other" to "VOICE",
    )

    private fun escape(value: String): String = value
        .replace("\\", "\\\\")
        .replace(Regex("\r\n|\r|\n"), "\\\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")

    private fun utf8Len(cp: Int): Int = when {
        cp < 0x80 -> 1
        cp < 0x800 -> 2
        cp < 0x10000 -> 3
        else -> 4
    }

    private fun fold(line: String): String {
        if (line.toByteArray(Charsets.UTF_8).size <= 75) return line
        val parts = ArrayList<String>()
        val current = StringBuilder()
        var octets = 0
        var limit = 75
        var i = 0
        while (i < line.length) {
            val cp = line.codePointAt(i)
            val size = utf8Len(cp)
            if (octets + size > limit) {
                parts.add(current.toString())
                current.setLength(0)
                octets = 0
                limit = 74
            }
            current.appendCodePoint(cp)
            octets += size
            i += Character.charCount(cp)
        }
        parts.add(current.toString())
        return parts.joinToString("\r\n ")
    }

    fun build(card: ContactCard): String {
        val trimmed = card.name.trim()
        val idx = trimmed.lastIndexOf(' ')
        val family = if (idx <= 0) "" else trimmed.substring(idx + 1)
        val given = if (idx <= 0) trimmed else trimmed.substring(0, idx)
        val lines = mutableListOf("BEGIN:VCARD", "VERSION:3.0", "N:${escape(family)};${escape(given)};;;", "FN:${escape(card.name)}")
        card.organization?.let { lines.add("ORG:${escape(it)}") }
        for (p in card.phones) {
            val type = LABEL_TO_PHONE_TYPE[(p.label ?: "").lowercase()] ?: "VOICE"
            lines.add("TEL;TYPE=$type:${escape(p.number)}")
        }
        for (e in card.emails) {
            val label = (e.label ?: "").lowercase()
            val type = if (label == "home" || label == "work") "INTERNET,${label.uppercase()}" else "INTERNET"
            lines.add("EMAIL;TYPE=$type:${escape(e.address)}")
        }
        card.note?.let { lines.add("NOTE:${escape(it)}") }
        lines.add("END:VCARD")
        return lines.joinToString("\r\n") { fold(it) } + "\r\n"
    }

    fun buildAll(cards: List<ContactCard>): String = cards.joinToString("") { build(it) }

    private fun unescape(value: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '\\' && i + 1 < value.length && value[i + 1] in "\\,;nN") {
                val n = value[i + 1]
                sb.append(if (n == 'n' || n == 'N') '\n' else n)
                i += 2
            } else {
                sb.append(c)
                i++
            }
        }
        return sb.toString()
    }

    private fun splitUnescaped(value: String, sep: Char): List<String> {
        val out = ArrayList<String>()
        val cur = StringBuilder()
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '\\' && i + 1 < value.length) {
                cur.append(c).append(value[i + 1]); i += 2; continue
            }
            if (c == sep) { out.add(cur.toString()); cur.setLength(0) } else cur.append(c)
            i++
        }
        out.add(cur.toString())
        return out
    }

    private fun decodeQuotedPrintable(value: String): String {
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '=' && i + 2 < value.length && value[i + 1].isHex() && value[i + 2].isHex()) {
                out.write(value.substring(i + 1, i + 3).toInt(16)); i += 3
            } else {
                out.write(c.toString().toByteArray(Charsets.UTF_8)); i++
            }
        }
        return String(out.toByteArray(), Charsets.UTF_8)
    }

    private fun Char.isHex() = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

    private class Prop(val name: String, val params: Map<String, List<String>>, val value: String)

    private fun parseProperty(line: String): Prop? {
        var inQuotes = false
        var colon = -1
        for (i in line.indices) {
            val c = line[i]
            if (c == '"') inQuotes = !inQuotes
            else if (c == ':' && !inQuotes) { colon = i; break }
        }
        if (colon <= 0) return null
        val head = line.substring(0, colon).split(';')
        val name = head[0].replace(Regex("^[^.]*\\."), "").uppercase()
        val params = LinkedHashMap<String, MutableList<String>>()
        for (raw in head.drop(1)) {
            val eq = raw.indexOf('=')
            val key = (if (eq == -1) "TYPE" else raw.substring(0, eq)).uppercase()
            val vals = (if (eq == -1) raw else raw.substring(eq + 1)).replace("\"", "").split(',')
                .map { it.trim().uppercase() }.filter { it.isNotEmpty() }
            params.getOrPut(key) { ArrayList() }.addAll(vals)
        }
        var value = line.substring(colon + 1)
        if (params["ENCODING"]?.contains("QUOTED-PRINTABLE") == true) value = decodeQuotedPrintable(value)
        return Prop(name, params, value)
    }

    private fun phoneLabel(types: List<String>): String? {
        for (t in types) if (t != "VOICE" && t != "PREF" && PHONE_TYPE_TO_LABEL.containsKey(t)) return PHONE_TYPE_TO_LABEL[t]
        return if (types.contains("VOICE")) "other" else null
    }

    fun parse(text: String): List<ContactCard> {
        if (text.length > Continuity.MAX_VCARD_LENGTH * 16) return emptyList()
        val rawLines = text.split(Regex("\r?\n"))
        val lines = ArrayList<String>()
        var i = 0
        while (i < rawLines.size) {
            var line = rawLines[i]
            if ((line.startsWith(" ") || line.startsWith("\t")) && lines.isNotEmpty()) {
                lines[lines.size - 1] = lines[lines.size - 1] + line.substring(1)
                i++
                continue
            }
            val colon = line.indexOf(':')
            if (colon > 0 && line.substring(0, colon).uppercase().contains("QUOTED-PRINTABLE")) {
                while (line.endsWith("=") && i + 1 < rawLines.size) {
                    i++
                    line = line.dropLast(1) + rawLines[i]
                }
            }
            lines.add(line)
            i++
        }
        val cards = ArrayList<ContactCard>()
        var inCard = false
        var fn: String? = null
        var n: String? = null
        var org: String? = null
        var note: String? = null
        val phones = ArrayList<ContactPhone>()
        val emails = ArrayList<ContactEmail>()
        for (raw in lines) {
            val line = raw.trimEnd()
            if (line.isEmpty()) continue
            val prop = parseProperty(line) ?: continue
            if (prop.name == "BEGIN" && prop.value.uppercase() == "VCARD") {
                inCard = true; fn = null; n = null; org = null; note = null; phones.clear(); emails.clear()
                continue
            }
            if (!inCard) continue
            when (prop.name) {
                "END" -> if (prop.value.uppercase() == "VCARD") {
                    val nameFromN = n?.let { raw2 ->
                        val parts = splitUnescaped(raw2, ';').map { unescape(it) }
                        listOf(parts.getOrElse(3) { "" }, parts.getOrElse(1) { "" }, parts.getOrElse(2) { "" }, parts.getOrElse(0) { "" }, parts.getOrElse(4) { "" })
                            .map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")
                    } ?: ""
                    val name = fn?.takeIf { it.isNotEmpty() } ?: nameFromN
                    Continuity.sanitizeContact(ContactCard(name, phones.toList(), emails.toList(), org, note))?.let { cards.add(it) }
                    inCard = false
                }
                "FN" -> fn = unescape(prop.value)
                "N" -> n = prop.value
                "ORG" -> org = splitUnescaped(prop.value, ';').map { unescape(it) }.filter { it.isNotEmpty() }.joinToString(", ")
                "NOTE" -> note = unescape(prop.value)
                "TEL" -> if (phones.size < Continuity.MAX_CONTACT_VALUES) {
                    phones.add(ContactPhone(unescape(prop.value).replace(Regex("^(?i)tel:"), ""), phoneLabel(prop.params["TYPE"] ?: emptyList())))
                }
                "EMAIL" -> if (emails.size < Continuity.MAX_CONTACT_VALUES) {
                    val types = (prop.params["TYPE"] ?: emptyList()).filter { it != "INTERNET" && it != "PREF" }
                    val label = when (types.firstOrNull()) { "HOME" -> "home"; "WORK" -> "work"; else -> null }
                    emails.add(ContactEmail(unescape(prop.value).replace(Regex("^(?i)mailto:"), ""), label))
                }
            }
        }
        return cards
    }
}

/**
 * Phone side of continuity: advertises features, answers contacts-request and
 * call-command from authorized computers, publishes call-state and streams
 * screen frames with credit-based flow control. All sends are asynchronous so
 * a slow socket never blocks the control thread or the capture loop.
 */
class ContinuityChannel internal constructor(private val host: Host) {
    internal interface Host {
        fun sendControl(peerId: String, payload: JsonValue.Obj)
        fun sendFrame(peerId: String, innerFrame: ByteArray): Boolean
        fun sessionKey(peerId: String): SecretKeySpec?
        fun peer(peerId: String): Peer?
        fun isAuthorized(peerId: String): Boolean
        fun isPaired(peerId: String): Boolean
        fun peerIds(): List<String>
        fun execute(task: () -> Unit)
        fun schedule(delayMs: Long, task: () -> Unit)
        fun listeners(): Iterable<EngineListener>
    }

    @Volatile var contactProvider: ContactProvider? = null
    @Volatile var callController: CallController? = null
    /** Provider present AND the user allowed it (permission + toggle). */
    @Volatile var contactsReady: Boolean = false
    @Volatile var callsReady: Boolean = false
    @Volatile var screenSourceAvailable: Boolean = false

    private class Source(val sessionId: String, val peerId: String, val maxWidth: Int, val maxFps: Int) {
        var nextSeq = 1L
        var ackedSeq = 0L
        var lastAckAt = System.currentTimeMillis()
        var lastSentAt = 0L
        val sentAt = HashMap<Long, Long>()
        var quality = 0.7
        var running = true
    }

    private val lock = Any()
    private val peerFeatures = HashMap<String, List<String>>()
    private var knownPeers = HashMap<String, String>()
    private val requests = LinkedHashMap<String, ScreenShareRequest>()
    private val sources = HashMap<String, Source>()
    private val seenShares = LinkedHashSet<String>()

    fun features(): List<String> {
        val out = mutableListOf(Continuity.FEATURE_CONTACTS_RECEIVE)
        if (contactProvider != null && contactsReady) out.add(Continuity.FEATURE_CONTACTS_PROVIDE)
        if (callController != null && callsReady) out.add(Continuity.FEATURE_CALLS_CONTROL)
        if (screenSourceAvailable) out.add(Continuity.FEATURE_SCREEN_SOURCE)
        return out
    }

    fun peerFeatures(peerId: String): List<String> = synchronized(lock) { peerFeatures[peerId] ?: emptyList() }

    /** Re-announce after a permission or toggle change. */
    fun announce(peerId: String? = null) {
        val payload = JsonValue.Obj()
            .put("kind", "continuity-hello")
            .put("v", Continuity.PROTOCOL_VERSION)
            .put("features", JsonValue.JsonArr(features().map { JsonValue.JsonStr(it) as JsonValue }.toMutableList()))
        val targets = if (peerId != null) listOf(peerId) else host.peerIds()
        for (id in targets) if (host.isPaired(id)) send(id, payload)
    }

    private fun send(peerId: String, payload: JsonValue.Obj) {
        host.execute { runCatching { host.sendControl(peerId, payload) } }
    }

    private fun peerName(peerId: String) = host.peer(peerId)?.device?.name ?: "Paired device"

    internal fun onPeersChanged(peers: List<Peer>) {
        val next = HashMap<String, String>()
        for (p in peers) next[p.peerId] = p.device.publicKey
        val announce = ArrayList<String>()
        val dropped = ArrayList<String>()
        synchronized(lock) {
            for ((id, key) in next) if (knownPeers[id] != key) announce.add(id)
            for (id in knownPeers.keys) if (!next.containsKey(id)) dropped.add(id)
            knownPeers = next
        }
        for (id in announce) {
            announce(id)
            val key = next[id]
            host.schedule(2_000) {
                val retry = synchronized(lock) { knownPeers[id] == key && !peerFeatures.containsKey(id) }
                if (retry) announce(id)
            }
        }
        for (id in dropped) dropPeer(id)
    }

    private fun dropPeer(peerId: String) {
        val ended = ArrayList<String>()
        synchronized(lock) {
            peerFeatures.remove(peerId)
            requests.values.filter { it.peerId == peerId }.forEach { requests.remove(it.sessionId); ended.add(it.sessionId) }
            sources.values.filter { it.peerId == peerId }.forEach { it.running = false; sources.remove(it.sessionId); ended.add(it.sessionId) }
        }
        for (id in ended) for (l in host.listeners()) l.onScreenShareEnded(id, "The computer disconnected")
        for (l in host.listeners()) l.onContinuityChanged()
    }

    internal fun stopAll() {
        val ended = synchronized(lock) {
            val ids = requests.keys.toList() + sources.keys.toList()
            sources.values.forEach { it.running = false }
            requests.clear(); sources.clear(); peerFeatures.clear(); knownPeers = HashMap()
            ids
        }
        for (id in ended) for (l in host.listeners()) runCatching { l.onScreenShareEnded(id, "AirBridge stopped") }
    }

    /** Returns true when [payload] was a continuity message. */
    internal fun handleControl(fromPeerId: String, payload: JsonValue.Obj): Boolean {
        when (payload.optStr("kind")) {
            "continuity-hello" -> {
                if (!host.isPaired(fromPeerId)) return true
                val features = payload.optArr("features")?.items?.mapNotNull { it.asStringOrNull()?.takeIf { f -> f in Continuity.FEATURES } }?.distinct() ?: emptyList()
                val first = synchronized(lock) { val f = !peerFeatures.containsKey(fromPeerId); peerFeatures[fromPeerId] = features; f }
                if (first) announce(fromPeerId)
                for (l in host.listeners()) l.onContinuityChanged()
            }
            "contacts-request" -> answerContacts(fromPeerId, payload)
            "contact-share" -> receiveContactShare(fromPeerId, payload)
            "call-command" -> executeCallCommand(fromPeerId, payload)
            "screen-share-request" -> receiveScreenRequest(fromPeerId, payload)
            "screen-share-ack" -> receiveAck(fromPeerId, payload.optStr("sessionId") ?: return true, payload.optLong("seq") ?: return true)
            "screen-share-stop" -> {
                val id = payload.optStr("sessionId") ?: return true
                val ended = synchronized(lock) {
                    val s = sources[id]?.takeIf { it.peerId == fromPeerId }
                    val r = requests[id]?.takeIf { it.peerId == fromPeerId }
                    if (s != null) { s.running = false; sources.remove(id) }
                    if (r != null) requests.remove(id)
                    s != null || r != null
                }
                if (ended) for (l in host.listeners()) l.onScreenShareEnded(id, "The computer stopped watching")
            }
            // Viewer-side and desktop-only kinds: the phone never asks, so ignore.
            "contacts-response", "call-state", "call-command-result", "screen-share-state" -> {}
            else -> return false
        }
        return true
    }

    // ---- contacts -------------------------------------------------------------

    private fun answerContacts(fromPeerId: String, payload: JsonValue.Obj) {
        val requestId = payload.optStr("requestId")?.takeIf { Continuity.isId(it) } ?: return
        fun reply(fill: (JsonValue.Obj) -> Unit) {
            val o = JsonValue.Obj().put("kind", "contacts-response").put("requestId", requestId)
            fill(o)
            send(fromPeerId, o)
        }
        if (!host.isAuthorized(fromPeerId)) return reply { it.put("error", "unauthorized") }
        val provider = contactProvider ?: return reply { it.put("error", "unsupported") }
        if (!contactsReady) return reply { it.put("error", "disabled").put("message", "Contacts access is turned off on the phone.") }
        val query = (payload.optStr("query") ?: "").trim().take(Continuity.MAX_CONTACT_QUERY)
        val limit = (payload.optLong("limit") ?: Continuity.DEFAULT_CONTACTS_LIMIT.toLong())
            .coerceIn(1, Continuity.MAX_CONTACTS_PER_RESPONSE.toLong()).toInt()
        host.execute {
            try {
                val all = provider.query(query, limit + 1).mapNotNull { Continuity.sanitizeContact(it) }
                val page = all.take(limit)
                reply {
                    it.put("contacts", JsonValue.JsonArr(page.map { c -> c.toJson() as JsonValue }.toMutableList()))
                        .put("total", all.size)
                        .put("truncated", all.size > limit)
                }
            } catch (e: ContinuityException) {
                reply { it.put("error", if (e.code in listOf("disabled", "permission", "unsupported")) e.code else "failed").putOpt("message", e.message?.take(200)) }
            } catch (e: Exception) {
                reply { it.put("error", "failed").putOpt("message", e.message?.take(200)) }
            }
        }
    }

    private fun receiveContactShare(fromPeerId: String, payload: JsonValue.Obj) {
        if (!host.isPaired(fromPeerId)) return
        val shareId = payload.optStr("shareId")?.takeIf { Continuity.isId(it) } ?: return
        val vcard = payload.optStr("vcard")?.takeIf { it.length <= Continuity.MAX_VCARD_LENGTH } ?: return
        synchronized(lock) {
            if (!seenShares.add(shareId)) return
            while (seenShares.size > 100) seenShares.remove(seenShares.first())
        }
        val contacts = VCard.parse(vcard)
        if (contacts.isEmpty()) return
        val item = ContactShareItem(shareId, fromPeerId, peerName(fromPeerId), contacts, VCard.buildAll(contacts), System.currentTimeMillis())
        for (l in host.listeners()) l.onContactsReceived(item)
    }

    /** Send contact cards (vCard 3.0) to a paired computer. */
    fun shareContacts(peerId: String, contacts: List<ContactCard>): ContactShareItem {
        val cards = contacts.mapNotNull { Continuity.sanitizeContact(it) }
        require(cards.isNotEmpty()) { "Nothing to share" }
        val vcard = VCard.buildAll(cards)
        require(vcard.length <= Continuity.MAX_VCARD_LENGTH) { "Too many contacts to share at once" }
        val item = ContactShareItem(AirCrypto.randomHex16(), peerId, peerName(peerId), cards, vcard, System.currentTimeMillis())
        host.sendControl(peerId, JsonValue.Obj().put("kind", "contact-share").put("shareId", item.shareId).put("vcard", vcard).put("timestamp", item.timestamp))
        return item
    }

    // ---- calls ----------------------------------------------------------------

    /** Report a call change to every authorized computer. */
    fun publishCallState(call: CallInfo) {
        val clean = Continuity.sanitizeCall(call) ?: return
        val payload = JsonValue.Obj().put("kind", "call-state").put("call", clean.toJson())
        for (id in host.peerIds()) if (host.isAuthorized(id)) send(id, payload)
    }

    private fun executeCallCommand(fromPeerId: String, payload: JsonValue.Obj) {
        val commandId = payload.optStr("commandId")?.takeIf { Continuity.isId(it) } ?: return
        fun reply(result: CallCommandResult) {
            send(fromPeerId, JsonValue.Obj()
                .put("kind", "call-command-result")
                .put("commandId", commandId)
                .put("ok", result.ok)
                .putOpt("error", result.error?.take(300))
                .putOpt("callId", result.callId?.takeIf { Continuity.isId(it) }))
        }
        if (!host.isAuthorized(fromPeerId)) return reply(CallCommandResult(false, "This computer is not verified for call control. Pair again with the code or QR."))
        val controller = callController ?: return reply(CallCommandResult(false, "Call control is not available on this device."))
        if (!callsReady) return reply(CallCommandResult(false, "Allow phone access in AirBridge on the phone, then try again."))
        val action = payload.optStr("action")?.takeIf { it in Continuity.CALL_ACTIONS } ?: return reply(CallCommandResult(false, "Unknown call action."))
        val command = if (action == "dial") {
            val number = Continuity.dialableNumber(payload.optStr("number")) ?: return reply(CallCommandResult(false, "Invalid phone number."))
            CallCommand(fromPeerId, action, number = number)
        } else {
            val callId = payload.optStr("callId")?.takeIf { Continuity.isId(it) } ?: return reply(CallCommandResult(false, "Unknown call."))
            CallCommand(fromPeerId, action, callId = callId)
        }
        host.execute {
            val result = try {
                controller.execute(command)
            } catch (e: Exception) {
                CallCommandResult(false, e.message?.take(200) ?: "Call command failed.")
            }
            reply(result)
        }
    }

    // ---- screen sharing (source) -----------------------------------------------

    private fun screenState(peerId: String, sessionId: String, state: String, reason: String? = null) {
        send(peerId, JsonValue.Obj().put("kind", "screen-share-state").put("sessionId", sessionId).put("state", state).putOpt("reason", reason))
    }

    private fun receiveScreenRequest(fromPeerId: String, payload: JsonValue.Obj) {
        val sessionId = payload.optStr("sessionId")?.takeIf { Continuity.isId(it) } ?: return
        if (synchronized(lock) { requests.containsKey(sessionId) || sources.containsKey(sessionId) }) return
        if (!host.isAuthorized(fromPeerId)) return screenState(fromPeerId, sessionId, "declined", "This device is not verified. Pair again with the code or QR.")
        if (!screenSourceAvailable) return screenState(fromPeerId, sessionId, "unsupported", "Screen sharing is not available on this phone.")
        val (maxWidth, maxFps) = Continuity.clampScreen(payload.optLong("maxWidth"), payload.optLong("maxFps"))
        val request = ScreenShareRequest(sessionId, fromPeerId, peerName(fromPeerId), maxWidth, maxFps, System.currentTimeMillis())
        synchronized(lock) { requests[sessionId] = request }
        screenState(fromPeerId, sessionId, "pending")
        host.schedule(Continuity.SCREEN_CONSENT_TIMEOUT_MS) {
            val expired = synchronized(lock) { requests.remove(sessionId) != null }
            if (expired) {
                screenState(fromPeerId, sessionId, "declined", "The request timed out.")
                for (l in host.listeners()) l.onScreenShareEnded(sessionId, "The request timed out")
            }
        }
        for (l in host.listeners()) l.onScreenShareRequest(request)
    }

    fun pendingScreenRequests(): List<ScreenShareRequest> = synchronized(lock) { requests.values.toList() }

    fun screenRequest(sessionId: String): ScreenShareRequest? = synchronized(lock) { requests[sessionId] }

    fun declineScreenShare(sessionId: String, reason: String = "Declined") {
        val req = synchronized(lock) { requests.remove(sessionId) } ?: return
        screenState(req.peerId, sessionId, "declined", reason)
    }

    /** The user consented (and the OS granted capture): frames may flow. */
    fun acceptScreenShare(sessionId: String): ScreenShareRequest? {
        val req = synchronized(lock) {
            val r = requests.remove(sessionId) ?: return null
            sources[sessionId] = Source(sessionId, r.peerId, r.maxWidth, r.maxFps)
            r
        }
        screenState(req.peerId, sessionId, "active")
        return req
    }

    fun isScreenShareActive(sessionId: String): Boolean = synchronized(lock) { sources[sessionId]?.running == true }

    /** JPEG quality (30–85) the capture loop should use right now. */
    fun screenQuality(sessionId: String): Int = synchronized(lock) { ((sources[sessionId]?.quality ?: 0.7) * 100).toInt() }

    /** Frame interval elapsed and the in-flight window has room (latest-frame-wins). */
    fun canSendScreenFrame(sessionId: String): Boolean = synchronized(lock) {
        val s = sources[sessionId] ?: return false
        if (!s.running) return false
        val now = System.currentTimeMillis()
        if (s.nextSeq - 1 - s.ackedSeq >= Continuity.SCREEN_MAX_INFLIGHT) {
            if (now - s.lastAckAt <= 3_000) return false
            s.ackedSeq = s.nextSeq - 1 // frames lost on a reconnect: forget them
            s.sentAt.clear()
            s.lastAckAt = now
        }
        now - s.lastSentAt >= 1000L / s.maxFps
    }

    /** Seals and queues one JPEG frame; false = dropped (no credit or socket busy). */
    fun sendScreenFrame(sessionId: String, jpeg: ByteArray, width: Int, height: Int): Boolean {
        if (jpeg.isEmpty() || jpeg.size > Continuity.SCREEN_MAX_FRAME_BYTES || width <= 0 || height <= 0) return false
        if (!canSendScreenFrame(sessionId)) return false
        val (peerId, seq) = synchronized(lock) {
            val s = sources[sessionId] ?: return false
            s.peerId to s.nextSeq
        }
        val key = host.sessionKey(peerId) ?: return false
        val aad = Continuity.encodeScreenAad(sessionId, seq, Continuity.SCREEN_CODEC_JPEG, width.coerceAtMost(0xffff), height.coerceAtMost(0xffff))
        val (iv, ct) = AirCrypto.encryptMediaFrame(key, aad, jpeg)
        val now = System.currentTimeMillis()
        synchronized(lock) {
            val s = sources[sessionId] ?: return false
            if (!s.running || s.nextSeq != seq) return false
            s.lastSentAt = now
        }
        if (!host.sendFrame(peerId, Continuity.encodeScreenFrame(aad, iv, ct))) return false
        synchronized(lock) {
            val s = sources[sessionId] ?: return false
            s.sentAt[seq] = now
            s.nextSeq = seq + 1
        }
        return true
    }

    private fun receiveAck(fromPeerId: String, sessionId: String, seq: Long) = synchronized(lock) {
        val s = sources[sessionId] ?: return@synchronized
        if (s.peerId != fromPeerId || seq <= s.ackedSeq || seq >= s.nextSeq) return@synchronized
        val now = System.currentTimeMillis()
        s.sentAt[seq]?.let { s.quality = Continuity.nextQuality(s.quality, now - it) }
        s.sentAt.keys.removeAll { it <= seq }
        s.ackedSeq = seq
        s.lastAckAt = now
    }

    /** Stop sharing (user, OS revoked capture, or service ended). */
    fun stopScreenShare(sessionId: String, reason: String = "Sharing stopped") {
        val s = synchronized(lock) { sources.remove(sessionId)?.also { it.running = false } }
        val r = synchronized(lock) { requests.remove(sessionId) }
        val peer = s?.peerId ?: r?.peerId ?: return
        screenState(peer, sessionId, if (s != null) "stopped" else "declined", reason)
    }
}
