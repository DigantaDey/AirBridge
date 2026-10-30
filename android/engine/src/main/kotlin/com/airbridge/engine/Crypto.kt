package com.airbridge.engine

import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * ECDH P-256 + HKDF-SHA256 + AES-256-GCM — a byte-compatible port of
 * src/client/engine/crypto.ts.
 *
 * Notes on interop:
 *  - raw public keys are uncompressed X9.63 points (0x04 || X || Y), 65 bytes
 *  - ECDH shared secret = big-endian X coordinate, padded to 32 bytes —
 *    identical to WebCrypto's deriveBits(..., 256)
 *  - AES-GCM tag is appended to the ciphertext (WebCrypto convention)
 */
data class IdentityKeys(
    val keyPair: KeyPair,
    val publicKeyB64: String,
) {
    val privateKey: PrivateKey get() = keyPair.private
    val publicKey: PublicKey get() = keyPair.public
}

data class PeerCryptoSession(
    val aesKey: SecretKeySpec,
    val rawAesKey: ByteArray,
    val sasCode: String,
    val fingerprintHex: String,
)

data class ControlEnvelope(
    val iv: ByteArray,
    val ciphertext: ByteArray,
)

object AirCrypto {
    private const val CURVE = "secp256r1" // == P-256
    private const val HKDF_INFO = "airbridge-warp-e2ee-v1"
    private const val SAS_CONTEXT = "airbridge-sas-v1:"
    private const val SALT_CONTEXT = "airbridge-salt:"
    private const val GCM_TAG_BITS = 128

    private val random = SecureRandom()

    val ecParameterSpec: ECParameterSpec by lazy {
        val params = java.security.AlgorithmParameters.getInstance("EC")
        params.init(ECGenParameterSpec(CURVE))
        params.getParameterSpec(ECParameterSpec::class.java)
    }

    fun generateIdentityKeyPair(): IdentityKeys {
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec(CURVE), random)
        val kp = kpg.generateKeyPair()
        return IdentityKeys(kp, Base64Url.encode(rawPublicKey(kp.public as java.security.interfaces.ECPublicKey)))
    }

    fun importPrivateKey(pkcs8: ByteArray): PrivateKey =
        KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8))

    /** Uncompressed X9.63 encoding: 0x04 || X(32) || Y(32). */
    fun rawPublicKey(pub: java.security.interfaces.ECPublicKey): ByteArray {
        val w = pub.w
        val out = ByteArray(65)
        out[0] = 0x04
        fixed32(w.affineX, out, 1)
        fixed32(w.affineY, out, 33)
        return out
    }

    private fun fixed32(v: java.math.BigInteger, out: ByteArray, offset: Int) {
        val bytes = v.toByteArray()
        val start = if (bytes.size > 32) bytes.size - 32 else 0
        val len = if (bytes.size > 32) 32 else bytes.size
        // right-aligned into 32 bytes
        System.arraycopy(bytes, start, out, offset + (32 - len), len)
    }

    fun importRawPublicKey(raw: ByteArray): PublicKey {
        require(raw.size == 65 && raw[0] == 0x04.toByte()) {
            "Uncompressed P-256 point required (65 bytes, 0x04 prefix), got ${raw.size}"
        }
        val x = java.math.BigInteger(1, raw.copyOfRange(1, 33))
        val y = java.math.BigInteger(1, raw.copyOfRange(33, 65))
        val spec = ECPublicKeySpec(ECPoint(x, y), ecParameterSpec)
        return KeyFactory.getInstance("EC").generatePublic(spec)
    }

    fun importRawPublicKeyB64(b64url: String): PublicKey =
        importRawPublicKey(Base64Url.decode(b64url))

    /** HKDF-SHA256 (RFC 5869) extract+expand. */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmacSha256(salt, ikm)
        val out = ByteArray(length)
        var tPrev = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            val t = hmacSha256(prk, tPrev + info + byteArrayOf(counter.toByte()))
            val copy = minOf(t.size, length - offset)
            System.arraycopy(t, 0, out, offset, copy)
            offset += copy
            tPrev = t
            counter++
        }
        return out
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)

    fun sha256Hex(data: ByteArray): String =
        sha256(data).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    /**
     * Derive the per-peer AES-GCM session key + SAS verification code,
     * matching derivePeerSession() in crypto.ts exactly.
     */
    fun derivePeerSession(
        myPrivate: PrivateKey,
        myPublicKeyB64: String,
        peerPublicKeyB64: String,
    ): PeerCryptoSession {
        val peerPub = importRawPublicKeyB64(peerPublicKeyB64)

        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(myPrivate)
        ka.doPhase(peerPub, true)
        val sharedSecret = ka.generateSecret() // X coordinate, curve-sized (32 bytes)

        val sortedPubs = listOf(myPublicKeyB64, peerPublicKeyB64).sorted().joinToString(":")
        val saltDigest = sha256((SALT_CONTEXT + sortedPubs).toByteArray(Charsets.UTF_8))
        val rawKey = hkdfSha256(sharedSecret, saltDigest, HKDF_INFO.toByteArray(Charsets.UTF_8), 32)
        val aesKey = SecretKeySpec(rawKey, "AES")

        val sasDigest = sha256((SAS_CONTEXT + sortedPubs).toByteArray(Charsets.UTF_8))
        val sixDigits = ((u32Be(sasDigest, 0) % 1_000_000L).toString()).padStart(6, '0')
        val sasCode = sixDigits.substring(0, 3) + " · " + sixDigits.substring(3, 6)

        val fpParts = mutableListOf<String>()
        var i = 4
        while (i < 10) {
            val word = (((sasDigest[i].toInt() and 0xff) shl 8) or
                (sasDigest[i + 1].toInt() and 0xff))
            fpParts.add(word.toString(16).uppercase().padStart(4, '0'))
            i += 2
        }

        return PeerCryptoSession(aesKey, rawKey, sasCode, fpParts.joinToString(":"))
    }

    private fun u32Be(b: ByteArray, offset: Int): Long =
        (((b[offset].toLong() and 0xff) shl 24) or
            ((b[offset + 1].toLong() and 0xff) shl 16) or
            ((b[offset + 2].toLong() and 0xff) shl 8) or
            (b[offset + 3].toLong() and 0xff)) and 0xffffffffL

    fun encryptControlPayload(aesKey: SecretKeySpec, plaintext: ByteArray): ControlEnvelope {
        val iv = ByteArray(Frames.GCM_IV_LENGTH)
        random.nextBytes(iv)
        return ControlEnvelope(iv, aesGcm(aesKey, iv, plaintext, encrypt = true))
    }

    fun decryptControlPayload(
        aesKey: SecretKeySpec,
        iv: ByteArray,
        ciphertext: ByteArray,
    ): ByteArray = aesGcm(aesKey, iv, ciphertext, encrypt = false)

    /** Chunk IV = 4 random bytes + fileIndex(BE u32) + chunkIndex(BE u32). */
    fun chunkIv(fileIndex: Int, chunkIndex: Int): ByteArray {
        val iv = ByteArray(Frames.GCM_IV_LENGTH)
        // Randomize the whole IV, then overwrite bytes 4..11 with the
        // (fileIndex, chunkIndex) counters — identical distribution to the
        // TypeScript side (4 random bytes + 2 big-endian u32 counters), and
        // avoids Random#nextBytes(byte[],int,int), which older Android APIs lack.
        random.nextBytes(iv)
        putU32Be(iv, 4, fileIndex)
        putU32Be(iv, 8, chunkIndex)
        return iv
    }

    private fun putU32Be(out: ByteArray, offset: Int, value: Int) {
        out[offset] = ((value ushr 24) and 0xff).toByte()
        out[offset + 1] = ((value ushr 16) and 0xff).toByte()
        out[offset + 2] = ((value ushr 8) and 0xff).toByte()
        out[offset + 3] = (value and 0xff).toByte()
    }

    fun encryptBinaryChunk(
        aesKey: SecretKeySpec,
        plaintext: ByteArray,
        fileIndex: Int,
        chunkIndex: Int,
    ): Pair<ByteArray, ByteArray> {
        val iv = chunkIv(fileIndex, chunkIndex)
        return iv to aesGcm(aesKey, iv, plaintext, encrypt = true)
    }

    fun decryptBinaryChunk(
        aesKey: SecretKeySpec,
        iv: ByteArray,
        ciphertext: ByteArray,
    ): ByteArray = aesGcm(aesKey, iv, ciphertext, encrypt = false)

    private fun aesGcm(
        key: SecretKeySpec,
        iv: ByteArray,
        data: ByteArray,
        encrypt: Boolean,
    ): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val spec = GCMParameterSpec(GCM_TAG_BITS, iv)
        cipher.init(if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, key, spec)
        return cipher.doFinal(data)
    }

    fun newRandomBytes(size: Int): ByteArray =
        ByteArray(size).also { random.nextBytes(it) }

    fun randomHex16(): String = randomHex(8)
}
