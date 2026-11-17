package com.airbridge.engine

import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec

/**
 * Code-authenticated joining — byte-for-byte mirror of
 * src/shared/pairingProof.ts (see that file for the protocol rationale).
 */
object PairingProof {
    const val JOIN_PROTOCOL_VERSION = 1
    val HUB_SPAKE2_IDENTITY: ByteArray = "airbridge-hub-v1".toByteArray(Charsets.UTF_8)
    val JOIN_SPAKE2_AAD: ByteArray = "airbridge-join-v1".toByteArray(Charsets.UTF_8)

    fun nameplateFor(code: String): String {
        val digest = AirCrypto.sha256("airbridge-nameplate-v1:${PairCode.normalize(code)}".toByteArray(Charsets.UTF_8))
        return (digest[0].toInt() and 0xff).toString(16).padStart(2, '0')
    }

    fun passwordScalar(code: String): BigInteger {
        val okm = AirCrypto.hkdfSha256(
            PairCode.normalize(code).toByteArray(Charsets.UTF_8),
            "airbridge-spake2-password-v1".toByteArray(Charsets.UTF_8),
            "w".toByteArray(Charsets.UTF_8),
            48,
        )
        val w = BigInteger(1, okm).mod(P256.N)
        return if (w.signum() == 0) BigInteger.ONE else w
    }

    fun joinerSpake2Identity(publicKey: String, identityKey: String?): ByteArray =
        "airbridge-joiner-v1\n$publicKey\n${identityKey ?: ""}".toByteArray(Charsets.UTF_8)

    fun vouchKeyFrom(ke: ByteArray): ByteArray =
        AirCrypto.hkdfSha256(ke, ByteArray(0), "airbridge-vouch-v1".toByteArray(Charsets.UTF_8), 32)

    fun peerVouch(vouchKey: ByteArray, peerId: String, publicKey: String, identityKey: String?, attestation: String): String {
        val msg = listOf("peer", peerId, publicKey, identityKey ?: "", attestation).joinToString("\n")
        return Base64Url.encode(AirCrypto.hmacSha256(vouchKey, msg.toByteArray(Charsets.UTF_8)).copyOfRange(0, 16))
    }

    fun verifyPeerVouch(vouchKey: ByteArray, peerId: String, publicKey: String, identityKey: String?, attestation: String, vouch: String?): Boolean =
        vouch != null && Spake2.constantTimeEquals(
            peerVouch(vouchKey, peerId, publicKey, identityKey, attestation).toByteArray(Charsets.UTF_8),
            vouch.toByteArray(Charsets.UTF_8),
        )

    fun hubProof(vouchKey: ByteArray, peerId: String, pairCode: String, tlsPin: String?): String {
        val msg = listOf("hub", peerId, PairCode.normalize(pairCode), tlsPin ?: "").joinToString("\n")
        return Base64Url.encode(AirCrypto.hmacSha256(vouchKey, msg.toByteArray(Charsets.UTF_8)))
    }

    fun verifyHubProof(vouchKey: ByteArray, peerId: String, pairCode: String, tlsPin: String?, proof: String?): Boolean =
        proof != null && Spake2.constantTimeEquals(
            hubProof(vouchKey, peerId, pairCode, tlsPin).toByteArray(Charsets.UTF_8),
            proof.toByteArray(Charsets.UTF_8),
        )

    /** Binds the computer's handoff key and Bluetooth tag secret to this session (handoffProof in pairingProof.ts). */
    fun handoffProof(vouchKey: ByteArray, peerId: String, key: String, beacon: String): String {
        val msg = listOf("handoff", peerId, key, beacon).joinToString("\n")
        return Base64Url.encode(AirCrypto.hmacSha256(vouchKey, msg.toByteArray(Charsets.UTF_8)))
    }

    fun verifyHandoffProof(vouchKey: ByteArray, peerId: String, key: String, beacon: String, proof: String?): Boolean =
        proof != null && Spake2.constantTimeEquals(
            handoffProof(vouchKey, peerId, key, beacon).toByteArray(Charsets.UTF_8),
            proof.toByteArray(Charsets.UTF_8),
        )

    fun identityBindingMessage(publicKey: String): ByteArray =
        "airbridge-device-binding-v1\n$publicKey".toByteArray(Charsets.UTF_8)

    /** Verify a peer's identity signature (raw r‖s) over its session key. Never throws. */
    fun verifyIdentityBinding(identityKeyB64: String, signatureB64: String, publicKeyB64: String): Boolean = try {
        val raw = Base64Url.decode(identityKeyB64)
        val sig = Base64Url.decode(signatureB64)
        if (raw.size != 65 || raw[0] != 0x04.toByte() || sig.size != 64) {
            false
        } else {
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(AirCrypto.importRawPublicKey(raw))
            verifier.update(identityBindingMessage(publicKeyB64))
            verifier.verify(EcdsaSignatures.rawToDer(sig))
        }
    } catch (_: Exception) {
        false
    }
}

/** ECDSA signature encodings: JOSE/WebCrypto raw r‖s ⇄ ASN.1 DER (JCA). */
object EcdsaSignatures {
    fun rawToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64) { "raw P-256 signature must be 64 bytes" }
        fun integer(bytes: ByteArray): ByteArray {
            var start = 0
            while (start < bytes.size - 1 && bytes[start] == 0.toByte()) start++
            var v = bytes.copyOfRange(start, bytes.size)
            if (v[0].toInt() and 0x80 != 0) v = byteArrayOf(0) + v
            return byteArrayOf(0x02, v.size.toByte()) + v
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    fun derToRaw(der: ByteArray): ByteArray {
        var i = 0
        require(der[i++] == 0x30.toByte()) { "not a DER sequence" }
        var len = der[i++].toInt() and 0xff
        if (len and 0x80 != 0) { val n = len and 0x7f; len = 0; repeat(n) { len = (len shl 8) or (der[i++].toInt() and 0xff) } }
        val out = ByteArray(64)
        for (part in 0..1) {
            require(der[i++] == 0x02.toByte()) { "not a DER integer" }
            val l = der[i++].toInt() and 0xff
            val v = BigInteger(1, der.copyOfRange(i, i + l))
            i += l
            P256.to32(v, out, part * 32)
        }
        return out
    }
}

/**
 * The device's long-term ECDSA P-256 identity. It only signs per-connection
 * ECDH keys (forward secrecy stays per connection) and is what peers pin as
 * "trusted". The app backs it with the Android Keystore (non-exportable).
 */
interface DeviceIdentity {
    /** Uncompressed 65-byte public key. */
    val publicKeyRaw: ByteArray
    /** SHA256withECDSA over [message], DER encoded (JCA convention). */
    fun signDer(message: ByteArray): ByteArray
    /** False for an in-memory fallback that changes every launch. */
    val persistent: Boolean

    val publicKeyB64: String get() = Base64Url.encode(publicKeyRaw)

    /** base64url raw r‖s signature over the binding message for [sessionPublicKeyB64]. */
    fun signBinding(sessionPublicKeyB64: String): String =
        Base64Url.encode(EcdsaSignatures.derToRaw(signDer(PairingProof.identityBindingMessage(sessionPublicKeyB64))))
}

/**
 * Software identity: PKCS#8 in a private file (or memory only when [file] is
 * null). Used by tests and as a fallback when no hardware keystore exists.
 */
class SoftwareDeviceIdentity(file: File? = null) : DeviceIdentity {
    private val privateKey: PrivateKey
    override val publicKeyRaw: ByteArray
    override val persistent: Boolean

    init {
        var loaded: Pair<PrivateKey, ByteArray>? = null
        val f = file
        if (f != null && f.isFile) {
            loaded = runCatching {
                val text = f.readText().trim().split('\n')
                val pkcs8 = Base64Url.decode(text[0])
                val pub = Base64Url.decode(text[1])
                require(pub.size == 65 && pub[0] == 0x04.toByte())
                KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8)) to pub
            }.getOrNull()
        }
        if (loaded == null) {
            val gen = KeyPairGenerator.getInstance("EC")
            gen.initialize(ECGenParameterSpec("secp256r1"))
            val kp = gen.generateKeyPair()
            val pub = AirCrypto.rawPublicKey(kp.public as ECPublicKey)
            var saved = false
            if (f != null) {
                saved = runCatching {
                    f.parentFile?.mkdirs()
                    val tmp = File(f.parentFile, f.name + ".tmp")
                    tmp.writeText(Base64Url.encode(kp.private.encoded) + "\n" + Base64Url.encode(pub) + "\n")
                    tmp.setReadable(false, false); tmp.setReadable(true, true)
                    tmp.setWritable(false, false); tmp.setWritable(true, true)
                    check(tmp.renameTo(f) || (f.delete() && tmp.renameTo(f)))
                }.isSuccess
            }
            privateKey = kp.private
            publicKeyRaw = pub
            persistent = saved
        } else {
            privateKey = loaded.first
            publicKeyRaw = loaded.second
            persistent = true
        }
    }

    override fun signDer(message: ByteArray): ByteArray {
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(privateKey)
        signer.update(message)
        return signer.sign()
    }
}
