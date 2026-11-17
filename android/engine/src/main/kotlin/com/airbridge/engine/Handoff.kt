package com.airbridge.engine

import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Hotspot handoff, phone side (byte-for-byte mirror of src/server/handoff.ts).
 *
 * When the phone and the computer share no usable network, the phone starts
 * a local-only hotspot and seals its credentials to the computer's static
 * handoff key, learned in the code-authenticated welcome (HandoffInfo, bound
 * by a MAC under the SPAKE2 vouch key). The sealed offer travels over the
 * current session (e.g. the relay) or Bluetooth LE; the computer joins the
 * hotspot and dials the phone's reverse listener at its new gateway.
 *
 *   envelope = 0x01 ‖ epk(65) ‖ iv(12) ‖ AES-256-GCM(k, iv, payloadJson, aad = 0x01 ‖ epk)
 *   k = HKDF-SHA256(ECDH-x(epk, K), "airbridge-handoff-v1", epk ‖ K, 32)
 *   payload.mac = HMAC(HKDF(code, "airbridge-handoff-auth-v1", "auth"), fields)[:16]
 */
object Handoff {
    const val VERSION = 1
    const val BEACON_WINDOW_MS = 15 * 60_000L

    /** GATT layout of the computer's Bluetooth handoff service (BLE_UUIDS in handoff.ts). */
    const val SERVICE_UUID = "c288bc57-57c6-44cc-9137-a59f85d3bf6f"
    const val TAG_UUID = "c288bc58-57c6-44cc-9137-a59f85d3bf6f"
    const val OFFER_UUID = "c288bc59-57c6-44cc-9137-a59f85d3bf6f"
    const val STATUS_UUID = "c288bc5a-57c6-44cc-9137-a59f85d3bf6f"

    private val SALT = "airbridge-handoff-v1".toByteArray(Charsets.UTF_8)
    private val AUTH_SALT = "airbridge-handoff-auth-v1".toByteArray(Charsets.UTF_8)
    private const val BEACON_LABEL = "airbridge-beacon-v1"

    /** What the computer handed over in its welcome. */
    data class Info(val key: String, val beacon: String, val proof: String) {
        fun toJson(): String = JsonValue.Obj().put("key", key).put("beacon", beacon).put("proof", proof).toJsonString()

        companion object {
            fun fromJson(obj: JsonValue?): Info? {
                val key = obj?.optStr("key") ?: return null
                val beacon = obj.optStr("beacon") ?: return null
                val proof = obj.optStr("proof") ?: return null
                if (obj.optLong("v")?.let { it != 1L } == true) return null
                return Info(key, beacon, proof)
            }

            fun parse(text: String?): Info? = text?.let { runCatching { fromJson(JsonValue.parse(it)) }.getOrNull() }
        }
    }

    enum class Security(val wire: String) { WPA2("wpa2"), WPA3("wpa3"), WPA2_WPA3("wpa2-wpa3") }

    data class Offer(
        val ssid: String,
        val psk: String,
        val security: Security,
        val reversePort: Int,
        val identityKey: String,
        val deviceName: String,
    )

    /** Statuses the computer reports (HandoffState in protocol.ts). */
    enum class State(val wire: String) {
        PENDING("pending"), JOINING("joining"), JOINED("joined"), DECLINED("declined"),
        EXPIRED("expired"), FAILED("failed"), INVALID("invalid"), ENDED("ended");

        val terminal: Boolean get() = this != PENDING && this != JOINING && this != JOINED

        companion object {
            fun fromWire(s: String?): State? = values().firstOrNull { it.wire == s }
        }
    }

    fun verifyInfo(vouchKey: ByteArray, peerId: String, info: Info): Boolean =
        PairingProof.verifyHandoffProof(vouchKey, peerId, info.key, info.beacon, info.proof)

    fun authKey(pairCode: String): ByteArray =
        AirCrypto.hkdfSha256(PairCode.normalize(pairCode).toByteArray(Charsets.UTF_8), AUTH_SALT, "auth".toByteArray(Charsets.UTF_8), 32)

    fun offerMac(authKey: ByteArray, o: Offer, issuedAt: Long, nonce: String): String {
        val msg = listOf("handoff-offer", o.ssid, o.psk, o.security.wire, o.reversePort.toString(), o.identityKey, o.deviceName, issuedAt.toString(), nonce)
            .joinToString("\n")
        return Base64Url.encode(AirCrypto.hmacSha256(authKey, msg.toByteArray(Charsets.UTF_8)).copyOf(16))
    }

    /** Checks what the phone is about to hand over (mirrors validateCredentials on the computer). */
    fun validate(o: Offer) {
        val ssidBytes = o.ssid.toByteArray(Charsets.UTF_8).size
        require(ssidBytes in 1..32 && o.ssid.none { it.code < 0x20 || it.code == 0x7f }) { "invalid hotspot name" }
        val hex64 = o.psk.length == 64 && o.psk.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }
        require(hex64 || (o.psk.length in 8..63 && o.psk.all { it.code in 0x20..0x7e })) { "invalid hotspot password" }
        require(o.reversePort in 1..65535) { "invalid reverse port" }
    }

    /**
     * Seals [offer] to the computer's handoff key. The optional parameters
     * exist for cross-language test vectors only.
     */
    fun seal(
        recipientKeyB64: String,
        pairCode: String,
        offer: Offer,
        ephemeralPrivate: BigInteger? = null,
        iv: ByteArray? = null,
        nonce: ByteArray? = null,
        issuedAt: Long? = null,
    ): ByteArray {
        validate(offer)
        val recipient = Base64Url.decode(recipientKeyB64)
        require(recipient.size == 65 && recipient[0] == 0x04.toByte()) { "bad handoff key" }
        val epk: ByteArray
        val shared: ByteArray
        if (ephemeralPrivate != null) {
            epk = P256.encodeUncompressed(P256.multiply(P256.G, ephemeralPrivate)!!)
            val point = P256.decodeUncompressed(recipient)
            require(P256.isOnCurve(point)) { "handoff key is not on P-256" }
            shared = P256.to32(P256.multiply(point, ephemeralPrivate)!!.x)
        } else {
            val gen = KeyPairGenerator.getInstance("EC")
            gen.initialize(ECGenParameterSpec("secp256r1"))
            val kp = gen.generateKeyPair()
            epk = AirCrypto.rawPublicKey(kp.public as java.security.interfaces.ECPublicKey)
            val ka = KeyAgreement.getInstance("ECDH")
            ka.init(kp.private)
            ka.doPhase(AirCrypto.importRawPublicKey(recipient), true)
            shared = ka.generateSecret()
        }
        val t = issuedAt ?: (System.currentTimeMillis() / 1000)
        val n = Base64Url.encode(nonce ?: AirCrypto.newRandomBytes(12))
        val payload = JsonValue.Obj()
            .put("v", 1)
            .put("ssid", offer.ssid)
            .put("psk", offer.psk)
            .put("sec", offer.security.wire)
            .put("rp", offer.reversePort)
            .put("id", offer.identityKey)
            .put("name", offer.deviceName)
            .put("t", t)
            .put("n", n)
            .put("mac", offerMac(authKey(pairCode), offer, t, n))
            .toJsonString()
            .toByteArray(Charsets.UTF_8)
        val key = AirCrypto.hkdfSha256(shared, SALT, epk + recipient, 32)
        val ivBytes = iv ?: AirCrypto.newRandomBytes(12)
        val header = byteArrayOf(VERSION.toByte()) + epk
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, ivBytes))
        cipher.updateAAD(header)
        return header + ivBytes + cipher.doFinal(payload)
    }

    /** 0x01 ‖ HMAC(beacon secret, label:window)[:8]: what the computer's GATT tag characteristic returns. */
    fun beaconTag(beaconSecret: ByteArray, nowMs: Long): ByteArray {
        val window = Math.floorDiv(nowMs, BEACON_WINDOW_MS)
        val mac = AirCrypto.hmacSha256(beaconSecret, "$BEACON_LABEL:$window".toByteArray(Charsets.UTF_8))
        return byteArrayOf(VERSION.toByte()) + mac.copyOf(8)
    }

    /** Accepts the current and neighbouring windows (clock skew, window edges). */
    fun matchesTag(beaconSecretB64: String, tag: ByteArray, nowMs: Long): Boolean {
        val secret = runCatching { Base64Url.decode(beaconSecretB64) }.getOrNull() ?: return false
        return listOf(-1L, 0L, 1L).any { d ->
            Spake2.constantTimeEquals(beaconTag(secret, nowMs + d * BEACON_WINDOW_MS), tag)
        }
    }

    /** {"s": state, "r": reason} from the GATT status characteristic. */
    fun parseBleStatus(bytes: ByteArray): Pair<State, String>? = runCatching {
        val obj = JsonValue.parse(String(bytes, Charsets.UTF_8))
        val state = State.fromWire(obj.optStr("s")) ?: return null
        state to (obj.optStr("r") ?: "")
    }.getOrNull()
}
