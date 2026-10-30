package com.airbridge.engine

import java.io.ByteArrayOutputStream

/**
 * Binary frame codecs — byte-for-byte ports of the TypeScript
 * src/shared/protocol.ts codecs:
 *
 *  0x01 encrypted chunk:  type(1) transferId(16 ascii) fileIndex(4 BE)
 *                         chunkIndex(4 BE) iv(12) ciphertext(...)
 *  0x02 routed relay:    type(1) targetPeerId(16) sourcePeerId(16) inner(...)
 */
object Frames {
    const val FRAME_ENCRYPTED_CHUNK = 0x01
    const val FRAME_ROUTED_RELAY = 0x02
    const val ID_ASCII_LENGTH = 16
    const val GCM_IV_LENGTH = 12
    const val CHUNK_HEADER_LENGTH = 1 + ID_ASCII_LENGTH + 4 + 4 + GCM_IV_LENGTH // 37
    const val ROUTING_HEADER_LENGTH = 1 + ID_ASCII_LENGTH + ID_ASCII_LENGTH // 33

    data class EncryptedChunkFrame(
        val transferId: String,
        val fileIndex: Int,
        val chunkIndex: Int,
        val iv: ByteArray,
        val ciphertext: ByteArray,
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
        val out = ByteArray(CHUNK_HEADER_LENGTH + frame.ciphertext.size)
        out[0] = FRAME_ENCRYPTED_CHUNK.toByte()
        writeFixedAsciiId(out, 1, frame.transferId)
        putU32Be(out, 17, frame.fileIndex)
        putU32Be(out, 21, frame.chunkIndex)
        System.arraycopy(frame.iv, 0, out, 25, GCM_IV_LENGTH)
        System.arraycopy(frame.ciphertext, 0, out, CHUNK_HEADER_LENGTH, frame.ciphertext.size)
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
}

internal fun randomHex(lengthBytes: Int): String {
    val bytes = java.security.SecureRandom().let { rnd ->
        ByteArray(lengthBytes).also { rnd.nextBytes(it) }
    }
    return bytes.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
}
