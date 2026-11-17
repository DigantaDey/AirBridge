package com.airbridge.engine

import java.math.BigInteger
import java.security.SecureRandom

/**
 * Minimal P-256 group arithmetic for SPAKE2. The JDK exposes ECDH/ECDSA but
 * not point addition, which SPAKE2 needs (X = x·G + w·M).
 *
 * Scalar multiplication is a Montgomery ladder with a fixed 256 iterations,
 * so the sequence of group operations does not depend on the scalar's bits.
 * BigInteger itself is not constant time; the only long-lived secret here is
 * the pairing code, and every run uses a fresh ephemeral scalar.
 */
object P256 {
    val P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    val N = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
    private val A = P.subtract(BigInteger.valueOf(3))
    private val B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    private val TWO = BigInteger.valueOf(2)
    private val THREE = BigInteger.valueOf(3)

    /** Affine point; `null` is the point at infinity. */
    data class Pt(val x: BigInteger, val y: BigInteger)

    val G = Pt(
        BigInteger("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", 16),
        BigInteger("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", 16),
    )

    fun isOnCurve(p: Pt): Boolean {
        if (p.x.signum() < 0 || p.x >= P || p.y.signum() < 0 || p.y >= P) return false
        val lhs = p.y.multiply(p.y).mod(P)
        val rhs = p.x.multiply(p.x).multiply(p.x).add(A.multiply(p.x)).add(B).mod(P)
        return lhs == rhs
    }

    fun negate(p: Pt?): Pt? = p?.let { Pt(it.x, P.subtract(it.y).mod(P)) }

    fun add(p1: Pt?, p2: Pt?): Pt? {
        if (p1 == null) return p2
        if (p2 == null) return p1
        if (p1.x == p2.x) {
            return if (p1.y.add(p2.y).mod(P).signum() == 0) null else double(p1)
        }
        val lambda = p2.y.subtract(p1.y).multiply(p2.x.subtract(p1.x).modInverse(P)).mod(P)
        val x3 = lambda.multiply(lambda).subtract(p1.x).subtract(p2.x).mod(P)
        val y3 = lambda.multiply(p1.x.subtract(x3)).subtract(p1.y).mod(P)
        return Pt(x3, y3)
    }

    fun double(p: Pt?): Pt? {
        if (p == null || p.y.signum() == 0) return null
        val lambda = THREE.multiply(p.x).multiply(p.x).add(A)
            .multiply(TWO.multiply(p.y).modInverse(P)).mod(P)
        val x3 = lambda.multiply(lambda).subtract(TWO.multiply(p.x)).mod(P)
        val y3 = lambda.multiply(p.x.subtract(x3)).subtract(p.y).mod(P)
        return Pt(x3, y3)
    }

    fun multiply(p: Pt?, k: BigInteger): Pt? {
        var r0: Pt? = null
        var r1: Pt? = p
        for (i in 255 downTo 0) {
            if (k.testBit(i)) {
                r0 = add(r0, r1); r1 = double(r1)
            } else {
                r1 = add(r0, r1); r0 = double(r0)
            }
        }
        return r0
    }

    fun encodeUncompressed(p: Pt): ByteArray {
        val out = ByteArray(65)
        out[0] = 0x04
        to32(p.x, out, 1)
        to32(p.y, out, 33)
        return out
    }

    /** Strict SEC1 uncompressed decode: right length, prefix, ranges, on-curve. */
    fun decodeUncompressed(bytes: ByteArray): Pt {
        require(bytes.size == 65 && bytes[0] == 0x04.toByte()) { "share must be an uncompressed P-256 point" }
        val p = Pt(BigInteger(1, bytes.copyOfRange(1, 33)), BigInteger(1, bytes.copyOfRange(33, 65)))
        require(isOnCurve(p)) { "share is not a valid P-256 point" }
        return p
    }

    fun decodeCompressed(hex: String): Pt {
        val bytes = hexToBytes(hex)
        require(bytes.size == 33 && (bytes[0] == 0x02.toByte() || bytes[0] == 0x03.toByte()))
        val x = BigInteger(1, bytes.copyOfRange(1, 33))
        val rhs = x.multiply(x).multiply(x).add(A.multiply(x)).add(B).mod(P)
        var y = rhs.modPow(P.add(BigInteger.ONE).shiftRight(2), P)
        require(y.multiply(y).mod(P) == rhs) { "not a curve point" }
        if (y.testBit(0) != (bytes[0] == 0x03.toByte())) y = P.subtract(y)
        return Pt(x, y)
    }

    fun to32(v: BigInteger, out: ByteArray = ByteArray(32), offset: Int = 0): ByteArray {
        val raw = v.toByteArray()
        val start = if (raw.size > 32) raw.size - 32 else 0
        require(raw.size <= 32 || raw.copyOfRange(0, start).all { it == 0.toByte() }) { "value exceeds 32 bytes" }
        val len = raw.size - start
        java.util.Arrays.fill(out, offset, offset + 32 - len, 0)
        System.arraycopy(raw, start, out, offset + 32 - len, len)
        return out
    }

    fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}

class Spake2Exception(message: String) : Exception(message)

/** Mirror of src/shared/spake2.ts (RFC 9382, P-256, SHA-256, HKDF, HMAC). */
class Spake2(
    private val role: Role,
    private val w: BigInteger,
    private val idA: ByteArray,
    private val idB: ByteArray,
    private val aad: ByteArray = ByteArray(0),
    private val scalar: BigInteger = randomScalar(),
) {
    enum class Role { A, B }

    class Result(
        val ke: ByteArray,
        val confirm: ByteArray,
        val expectedPeerConfirm: ByteArray,
        val transcript: ByteArray,
    )

    private val own: ByteArray
    private var finished = false

    init {
        if (w.signum() <= 0 || w >= P256.N) throw Spake2Exception("password scalar out of range")
        if (scalar.signum() <= 0 || scalar >= P256.N) throw Spake2Exception("ephemeral scalar out of range")
        val blind = if (role == Role.A) M else N
        val point = P256.add(P256.multiply(P256.G, scalar), P256.multiply(blind, w))
            ?: throw Spake2Exception("degenerate share")
        own = P256.encodeUncompressed(point)
    }

    fun share(): ByteArray = own.copyOf()

    @Synchronized
    fun finish(peerShare: ByteArray): Result {
        if (finished) throw Spake2Exception("SPAKE2 party already finished")
        finished = true
        val peer = try { P256.decodeUncompressed(peerShare) } catch (e: IllegalArgumentException) {
            throw Spake2Exception(e.message ?: "invalid share")
        }
        val peerBlind = if (role == Role.A) N else M
        val unblinded = P256.add(peer, P256.negate(P256.multiply(peerBlind, w)))
            ?: throw Spake2Exception("degenerate share")
        val k = P256.multiply(unblinded, scalar) ?: throw Spake2Exception("degenerate shared point")
        val pA = if (role == Role.A) own else peerShare
        val pB = if (role == Role.A) peerShare else own
        val tt = java.io.ByteArrayOutputStream().apply {
            for (part in listOf(idA, idB, pA, pB, P256.encodeUncompressed(k), P256.to32(w))) {
                write(lenLe8(part.size)); write(part)
            }
        }.toByteArray()
        val hash = AirCrypto.sha256(tt)
        val ke = hash.copyOfRange(0, 16)
        val ka = hash.copyOfRange(16, 32)
        val kc = AirCrypto.hkdfSha256(ka, ByteArray(0), "ConfirmationKeys".toByteArray(Charsets.UTF_8) + aad, 32)
        val confirmA = AirCrypto.hmacSha256(kc.copyOfRange(0, 16), tt)
        val confirmB = AirCrypto.hmacSha256(kc.copyOfRange(16, 32), tt)
        return if (role == Role.A) Result(ke, confirmA, confirmB, tt) else Result(ke, confirmB, confirmA, tt)
    }

    companion object {
        val M: P256.Pt = P256.decodeCompressed("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f")
        val N: P256.Pt = P256.decodeCompressed("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49")
        private val rng = SecureRandom()

        fun randomScalar(): BigInteger {
            while (true) {
                val bytes = ByteArray(48).also { rng.nextBytes(it) }
                val v = BigInteger(1, bytes).mod(P256.N)
                if (v.signum() != 0) return v
            }
        }

        private fun lenLe8(n: Int): ByteArray = ByteArray(8) { i -> ((n.toLong() ushr (8 * i)) and 0xff).toByte() }

        fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = java.security.MessageDigest.isEqual(a, b)
    }
}
