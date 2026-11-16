package com.airbridge.engine

import java.util.Base64
import java.util.Locale

/** Minimal persistent key/value surface (SharedPreferences on Android, a map in tests). */
interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
    fun remove(key: String)
    /** Durable write; returns false when the platform could not persist. */
    fun commitString(key: String, value: String): Boolean { putString(key, value); return true }
}

class InMemoryKeyValueStore : KeyValueStore {
    val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun getString(key: String): String? = values[key]
    override fun putString(key: String, value: String) { values[key] = value }
    override fun remove(key: String) { values.remove(key) }
}

/** Everything the native engine needs to start one connection to the paired computer. */
data class BootstrapPlan(
    /** Primary invitation (no pair code), with QR alternates and pin. */
    val link: PairingLink,
    /** Code for the hello: fresh scan > invitation > saved. */
    val pairCode: String,
    /** True when [pairCode] came from a QR scanned since the last engine start. */
    val freshScan: Boolean,
    /** Candidate hosts in priority order before local-network ranking. */
    val candidateHosts: List<String>,
)

/**
 * Pairing invitation state, shared by the scanner (ViewModel), the service
 * and tests.
 *
 *  - [stage] replaces the whole previous invitation: target, QR alternates,
 *    TLS pin, staged pair code, endpoints learned from an older network.
 *  - [bootstrap] consumes the staged code exactly once, so a freshly scanned
 *    code always beats yesterday's saved code, and an old unconsumed invite
 *    can never be replayed later.
 *  - [learn] records the addresses the computer reports after an
 *    authenticated connection so a reconnect after an address change can use
 *    them; a new scan discards them.
 *
 * The TLS anchor stays keyed by the primary authority (unchanged on-disk
 * format) and is shared by all candidate addresses of that invitation: they
 * are the same computer, and with a QR pin the anchor is authenticated.
 */
class PairingInvitationStore(private val kv: KeyValueStore) {
    companion object {
        const val KEY_TARGET = "target"
        const val KEY_LEGACY_TARGET = "serverUrl"
        const val KEY_PAIR_CODE = "pairCode"
        const val KEY_PENDING_PAIR_CODE = "pendingPairCode"
        const val KEY_ALTERNATES = "targetAlternates"
        const val KEY_TLS_PIN = "targetTlsPin"
        const val KEY_LEARNED = "learnedHosts"
        const val KEY_LAST_GOOD = "lastGoodHost"
        const val KEY_GENERATION = "invitationGeneration"
        const val MAX_CANDIDATES = 8
        const val MAX_LEARNED = 6

        fun tlsAnchorKey(link: PairingLink) = "tlsAnchor:" + link.authority.lowercase(Locale.ROOT)
    }

    private val lock = Any()

    /** Base URL of the paired computer, or empty when unpaired. */
    val target: String
        get() = ((kv.getString(KEY_TARGET) ?: kv.getString(KEY_LEGACY_TARGET)) ?: "").trim()

    var pairCode: String
        get() = kv.getString(KEY_PAIR_CODE) ?: ""
        set(value) = kv.putString(KEY_PAIR_CODE, value)

    val pendingPairCode: String get() = kv.getString(KEY_PENDING_PAIR_CODE) ?: ""

    /** Bumped by every [stage]; lets the service restart for a rescan of the same computer. */
    val generation: Long get() = kv.getString(KEY_GENERATION)?.toLongOrNull() ?: 0L

    /**
     * Identity of the invitation a running engine was built from. The service
     * must restart the engine whenever this changes, including a rescan of
     * the same computer (same target, fresh code / alternates / pin) — a
     * target-only comparison would leave the fresh code staged and unused.
     */
    val engineKey: String get() = "$target#$generation"

    private fun csv(key: String): List<String> =
        kv.getString(key).orEmpty().split(',').map { it.trim() }.filter { PairingLink.isValidAlternateHost(it) }

    /** The paired computer with its QR alternates and pin, or null when unpaired. */
    fun link(): PairingLink? {
        val base = PairingLink.parse(target) ?: return null
        if (base.host.isEmpty()) return null
        val pin = kv.getString(KEY_TLS_PIN)?.takeIf { PairingLink.isValidPin(it) } ?: base.tlsPin
        val alternates = (base.alternateHosts + csv(KEY_ALTERNATES)).distinctBy { it.lowercase() }
            .filterNot { it.equals(base.host, ignoreCase = true) }
        return base.copy(alternateHosts = alternates, tlsPin = pin)
    }

    val learnedHosts: List<String> get() = csv(KEY_LEARNED)

    /** Stage a scanned/typed invitation. Always replaces any previous one. */
    fun stage(link: PairingLink) = synchronized(lock) {
        kv.putString(KEY_TARGET, link.baseUrl)
        kv.remove(KEY_LEGACY_TARGET)
        // Clear (not keep) for a manual address: an old unconsumed QR code
        // must never be replayed into a different invitation.
        kv.putString(KEY_PENDING_PAIR_CODE, link.pairCode.orEmpty())
        if (link.alternateHosts.isEmpty()) kv.remove(KEY_ALTERNATES)
        else kv.putString(KEY_ALTERNATES, link.alternateHosts.joinToString(","))
        if (link.tlsPin != null) kv.putString(KEY_TLS_PIN, link.tlsPin) else kv.remove(KEY_TLS_PIN)
        // Endpoints learned on a previous network are stale for a new scan.
        kv.remove(KEY_LEARNED)
        kv.remove(KEY_LAST_GOOD)
        kv.putString(KEY_GENERATION, (generation + 1).toString())
    }

    fun consumePendingPairCode(): String? = synchronized(lock) {
        val code = pendingPairCode
        if (code.isEmpty()) return null
        kv.putString(KEY_PENDING_PAIR_CODE, "")
        code
    }

    /** Resolve the next connection. Consumes the staged code. Null when unpaired. */
    fun bootstrap(): BootstrapPlan? = synchronized(lock) {
        val link = link() ?: return null
        val pending = consumePendingPairCode()
        val code = PairingCodeBootstrap.resolve(pendingScanned = pending, invitation = link.pairCode, saved = pairCode)
        if (code.isNotBlank()) pairCode = code
        BootstrapPlan(link.copy(pairCode = null), code, pending != null, candidateHosts(link))
    }

    /** Primary + QR alternates + learned endpoints, last working host first. */
    fun candidateHosts(): List<String> = link()?.let { candidateHosts(it) } ?: emptyList()

    fun candidateHosts(link: PairingLink): List<String> {
        val lastGood = kv.getString(KEY_LAST_GOOD)
        val all = (link.candidateHosts + learnedHosts).distinctBy { it.lowercase() }
        val ordered = if (lastGood != null && all.any { it.equals(lastGood, ignoreCase = true) }) {
            listOf(lastGood) + all.filterNot { it.equals(lastGood, ignoreCase = true) }
        } else all
        return ordered.take(MAX_CANDIDATES)
    }

    /** Record the computer's current addresses (from an authenticated welcome/network message). */
    fun learn(lanUrls: List<String>) = synchronized(lock) {
        val link = link() ?: return
        val hosts = lanUrls.mapNotNull { PairingLink.parse(it) }
            .filter { it.port == link.port && it.scheme == link.scheme }
            .map { it.host }
            .filter { PairingLink.isValidAlternateHost(it) }
            .distinctBy { it.lowercase() }
            .take(MAX_LEARNED)
        if (hosts.isEmpty()) kv.remove(KEY_LEARNED) else kv.putString(KEY_LEARNED, hosts.joinToString(","))
    }

    fun markConnected(host: String) {
        if (PairingLink.isValidAlternateHost(host)) kv.putString(KEY_LAST_GOOD, host)
    }

    fun loadTlsAnchor(link: PairingLink): ByteArray? =
        kv.getString(tlsAnchorKey(link))?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }

    fun saveTlsAnchor(link: PairingLink, der: ByteArray) {
        check(kv.commitString(tlsAnchorKey(link), Base64.getEncoder().encodeToString(der))) {
            "Could not save the computer's TLS identity"
        }
    }

    /** Pin keyed by the primary authority; enforces the QR pin when present. */
    fun tlsTrust(link: PairingLink): PinnedTlsTrust =
        PinnedTlsTrust({ loadTlsAnchor(link) }, { saveTlsAnchor(link, it) }, link.tlsPin)

    fun forget() = synchronized(lock) {
        link()?.let { kv.remove(tlsAnchorKey(it)) }
        for (key in listOf(KEY_TARGET, KEY_LEGACY_TARGET, KEY_PAIR_CODE, KEY_PENDING_PAIR_CODE, KEY_ALTERNATES, KEY_TLS_PIN, KEY_LEARNED, KEY_LAST_GOOD)) {
            kv.remove(key)
        }
        kv.putString(KEY_GENERATION, (generation + 1).toString())
    }
}
