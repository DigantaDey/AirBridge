package com.airbridge.engine

import java.io.ByteArrayOutputStream

/**
 * Binary frame codecs — byte-for-byte ports of the TypeScript
 * src/shared/protocol.ts codecs:
 *
 *  0x01 encrypted chunk:  type(1) transferId(16 ascii) fileIndex(4 BE)
 *                         chunkIndex(4 BE) iv(12) ciphertext(...)
 *  0x02 routed relay:    type(1) targetPeerId(16) sourcePeerId(16) inner(...)
 *  0x03 binary SACK:     type(1) transferId(8 raw hex bytes) fileIndex(2 BE)
 *                         chunkIndex(4 BE) bitmask(1)
 */
object Frames {
    const val FRAME_ENCRYPTED_CHUNK = 0x01
    const val FRAME_ROUTED_RELAY = 0x02
    const val FRAME_BINARY_SACK = 0x03
    const val ID_ASCII_LENGTH = 16
    const val GCM_IV_LENGTH = 12
    const val CHUNK_HEADER_LENGTH = 1 + ID_ASCII_LENGTH + 4 + 4 + GCM_IV_LENGTH // 37
    const val ROUTING_HEADER_LENGTH = 1 + ID_ASCII_LENGTH + ID_ASCII_LENGTH // 33
    const val BINARY_SACK_LENGTH = 16

    data class EncryptedChunkFrame(
        val transferId: String,
        val fileIndex: Int,
        val chunkIndex: Int,
        val iv: ByteArray,
        val ciphertext: ByteArray,
        val ciphertextOffset: Int = 0,
        val ciphertextLength: Int = ciphertext.size,
    )

    data class BinarySackFrame(
        val transferId: String,
        val fileIndex: Int,
        val chunkIndex: Int,
        val bitmask: Int = 0,
    )

    data class RoutedRelayFrame(
        val targetPeerId: String,
        val sourcePeerId: String,
        val payload: ByteArray,
    )

    private fun writeFixedAsciiId(target: ByteArray, offset: Int, id: String) {
        val padded = (id.take(ID_ASCII_LENGTH) + "0".repeat(ID_ASCII_LENGTH)).take(ID_ASCII_LENGTH)
        for (i in 0 until ID_ASCII_LENGTH) {
            target[offset + i] = (padded[i].code and 0x7f).toByte()
        }
    }

    private fun readFixedAsciiId(source: ByteArray, offset: Int): String =
        String(source, offset, ID_ASCII_LENGTH, Charsets.US_ASCII)

    private fun putU32Be(out: ByteArray, offset: Int, value: Int) {
        out[offset] = ((value ushr 24) and 0xff).toByte()
        out[offset + 1] = ((value ushr 16) and 0xff).toByte()
        out[offset + 2] = ((value ushr 8) and 0xff).toByte()
        out[offset + 3] = (value and 0xff).toByte()
    }

    private fun getU32Be(src: ByteArray, offset: Int): Int =
        ((src[offset].toInt() and 0xff) shl 24) or
            ((src[offset + 1].toInt() and 0xff) shl 16) or
            ((src[offset + 2].toInt() and 0xff) shl 8) or
            (src[offset + 3].toInt() and 0xff)

    fun encodeEncryptedChunkFrame(frame: EncryptedChunkFrame): ByteArray {
        require(frame.iv.size == GCM_IV_LENGTH) {
            "Invalid IV length: expected $GCM_IV_LENGTH, got ${frame.iv.size}"
        }
        val out = ByteArray(CHUNK_HEADER_LENGTH + frame.ciphertextLength)
        out[0] = FRAME_ENCRYPTED_CHUNK.toByte()
        writeFixedAsciiId(out, 1, frame.transferId)
        putU32Be(out, 17, frame.fileIndex)
        putU32Be(out, 21, frame.chunkIndex)
        System.arraycopy(frame.iv, 0, out, 25, GCM_IV_LENGTH)
        System.arraycopy(frame.ciphertext, frame.ciphertextOffset, out, CHUNK_HEADER_LENGTH, frame.ciphertextLength)
        return out
    }

    fun decodeEncryptedChunkFrame(bytes: ByteArray): EncryptedChunkFrame {
        require(bytes.size >= CHUNK_HEADER_LENGTH) { "Chunk frame too short: ${bytes.size} bytes" }
        require((bytes[0].toInt() and 0xff) == FRAME_ENCRYPTED_CHUNK) {
            "Unexpected chunk frame type: 0x${(bytes[0].toInt() and 0xff).toString(16)}"
        }
        val transferId = readFixedAsciiId(bytes, 1)
        val fileIndex = getU32Be(bytes, 17)
        val chunkIndex = getU32Be(bytes, 21)
        val iv = bytes.copyOfRange(25, 37)
        val ciphertext = bytes.copyOfRange(CHUNK_HEADER_LENGTH, bytes.size)
        return EncryptedChunkFrame(transferId, fileIndex, chunkIndex, iv, ciphertext)
    }

    /** Decode directly from the received socket buffer: no intermediate 256 KiB copies. */
    fun decodeRoutedEncryptedChunkFrame(bytes: ByteArray): Pair<String, EncryptedChunkFrame> {
        val offset = ROUTING_HEADER_LENGTH
        require(bytes.size >= offset + CHUNK_HEADER_LENGTH + 16) { "Encrypted routed frame too short" }
        require(bytes[0].toInt() == FRAME_ROUTED_RELAY && bytes[offset].toInt() == FRAME_ENCRYPTED_CHUNK)
        val frame = EncryptedChunkFrame(
            readFixedAsciiId(bytes, offset + 1), getU32Be(bytes, offset + 17), getU32Be(bytes, offset + 21),
            bytes.copyOfRange(offset + 25, offset + 37), bytes,
            offset + CHUNK_HEADER_LENGTH, bytes.size - offset - CHUNK_HEADER_LENGTH,
        )
        return readFixedAsciiId(bytes, 17) to frame
    }

    /** Encrypt and frame an outgoing routed chunk in a single allocation. */
    fun encodeRoutedEncryptedChunk(
        targetPeerId: String,
        sourcePeerId: String,
        transferId: String,
        fileIndex: Int,
        chunkIndex: Int,
        aesKey: javax.crypto.spec.SecretKeySpec,
        plaintext: ByteArray,
        plaintextLength: Int = plaintext.size,
    ): ByteArray {
        val innerOffset = ROUTING_HEADER_LENGTH
        val ciphertextOffset = innerOffset + CHUNK_HEADER_LENGTH
        val out = ByteArray(ciphertextOffset + plaintextLength + 16)
        out[0] = FRAME_ROUTED_RELAY.toByte()
        writeFixedAsciiId(out, 1, targetPeerId)
        writeFixedAsciiId(out, 17, sourcePeerId)
        out[innerOffset] = FRAME_ENCRYPTED_CHUNK.toByte()
        writeFixedAsciiId(out, innerOffset + 1, transferId)
        putU32Be(out, innerOffset + 17, fileIndex)
        putU32Be(out, innerOffset + 21, chunkIndex)
        val written = AirCrypto.encryptBinaryChunkInto(
            aesKey = aesKey,
            plaintext = plaintext,
            plaintextLength = plaintextLength,
            ivOut = out,
            ivOffset = innerOffset + 25,
            ciphertextOut = out,
            ciphertextOffset = ciphertextOffset,
        )
        return if (written == plaintextLength + 16) out else out.copyOf(ciphertextOffset + written)
    }

    fun wrapRoutedRelayFrame(
        targetPeerId: String,
        sourcePeerId: String,
        innerPayload: ByteArray,
    ): ByteArray {
        val out = ByteArray(ROUTING_HEADER_LENGTH + innerPayload.size)
        out[0] = FRAME_ROUTED_RELAY.toByte()
        writeFixedAsciiId(out, 1, targetPeerId)
        writeFixedAsciiId(out, 17, sourcePeerId)
        System.arraycopy(innerPayload, 0, out, ROUTING_HEADER_LENGTH, innerPayload.size)
        return out
    }

    fun unwrapRoutedRelayFrame(bytes: ByteArray): RoutedRelayFrame {
        require(bytes.size >= ROUTING_HEADER_LENGTH) { "Routed frame too short: ${bytes.size} bytes" }
        require((bytes[0].toInt() and 0xff) == FRAME_ROUTED_RELAY) {
            "Unexpected routed frame type: 0x${(bytes[0].toInt() and 0xff).toString(16)}"
        }
        val targetPeerId = readFixedAsciiId(bytes, 1)
        val sourcePeerId = readFixedAsciiId(bytes, 17)
        val payload = bytes.copyOfRange(ROUTING_HEADER_LENGTH, bytes.size)
        return RoutedRelayFrame(targetPeerId, sourcePeerId, payload)
    }

    private fun hexNibble(c: Char): Int = when (c) {
        in '0'..'9' -> c.code - '0'.code
        in 'a'..'f' -> c.code - 'a'.code + 10
        in 'A'..'F' -> c.code - 'A'.code + 10
        else -> -1
    }

    /**
     * Compact 16-byte binary SACK wrapped directly inside a 0x02 routed relay frame.
     * Returns null when transferId is not 16 hex chars or fileIndex exceeds uint16
     * so callers fall back seamlessly to JSON `chunk-ack`.
     */
    fun encodeRoutedBinarySack(
        targetPeerId: String,
        sourcePeerId: String,
        transferId: String,
        fileIndex: Int,
        chunkIndex: Int,
        bitmask: Int = 0,
    ): ByteArray? {
        if (transferId.length != 16 || fileIndex !in 0..0xffff || chunkIndex < 0) return null
        val out = ByteArray(ROUTING_HEADER_LENGTH + BINARY_SACK_LENGTH)
        out[0] = FRAME_ROUTED_RELAY.toByte()
        writeFixedAsciiId(out, 1, targetPeerId)
        writeFixedAsciiId(out, 17, sourcePeerId)
        val o = ROUTING_HEADER_LENGTH
        out[o] = FRAME_BINARY_SACK.toByte()
        for (i in 0 until 8) {
            val hi = hexNibble(transferId[i * 2])
            val lo = hexNibble(transferId[i * 2 + 1])
            if (hi < 0 || lo < 0) return null
            out[o + 1 + i] = ((hi shl 4) or lo).toByte()
        }
        out[o + 9] = ((fileIndex ushr 8) and 0xff).toByte()
        out[o + 10] = (fileIndex and 0xff).toByte()
        putU32Be(out, o + 11, chunkIndex)
        out[o + 15] = (bitmask and 0xff).toByte()
        return out
    }

    fun decodeRoutedBinarySackFrame(bytes: ByteArray): Pair<String, BinarySackFrame> {
        val o = ROUTING_HEADER_LENGTH
        require(bytes.size == o + BINARY_SACK_LENGTH) { "Binary SACK routed frame invalid length: ${bytes.size}" }
        require((bytes[0].toInt() and 0xff) == FRAME_ROUTED_RELAY && (bytes[o].toInt() and 0xff) == FRAME_BINARY_SACK)
        val hexChars = "0123456789abcdef"
        val tid = CharArray(16)
        for (i in 0 until 8) {
            val b = bytes[o + 1 + i].toInt() and 0xff
            tid[i * 2] = hexChars[b ushr 4]
            tid[i * 2 + 1] = hexChars[b and 0x0f]
        }
        val fileIndex = ((bytes[o + 9].toInt() and 0xff) shl 8) or (bytes[o + 10].toInt() and 0xff)
        val chunkIndex = getU32Be(bytes, o + 11)
        val bitmask = bytes[o + 15].toInt() and 0xff
        return readFixedAsciiId(bytes, 17) to BinarySackFrame(String(tid), fileIndex, chunkIndex, bitmask)
    }
}

internal fun randomHex(lengthBytes: Int): String {
    val bytes = java.security.SecureRandom().let { rnd ->
        ByteArray(lengthBytes).also { rnd.nextBytes(it) }
    }
    return bytes.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
}
