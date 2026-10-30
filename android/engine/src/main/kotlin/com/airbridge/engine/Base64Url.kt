package com.airbridge.engine

import java.util.Base64

/**
 * Base64URL helpers byte-compatible with the TypeScript
 * `bytesToBase64Url` / `base64UrlToBytes` (unpadded, `-`/`_` alphabet).
 */
object Base64Url {
    fun encode(data: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(data)

    fun decode(text: String): ByteArray {
        val padded = text.replace('-', '+').replace('_', '/') +
            "=".repeat((4 - text.length % 4) % 4)
        return Base64.getDecoder().decode(padded)
    }

    /** Standard base64 (with padding) — used inside data: URLs. */
    fun encodeStandard(data: ByteArray): String =
        Base64.getEncoder().encodeToString(data)

    fun decodeStandard(text: String): ByteArray = Base64.getDecoder().decode(text)
}

/**
 * Pair code formatting & generation — direct port of
 * src/shared/protocol.ts (32-char Crockford-like alphabet, 6 chars, 30 bits).
 */
object PairCode {
    const val ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    const val LENGTH = 6

    fun generate(random: ByteArray): String {
        val sb = StringBuilder(LENGTH)
        for (i in 0 until LENGTH) {
            val b = random[i % random.size].toInt() and 0xff
            sb.append(ALPHABET[b % ALPHABET.length])
        }
        return sb.toString()
    }

    fun normalize(raw: String): String {
        val cleaned = raw.uppercase()
            .replace(Regex("[^A-Z0-9]"), "")
            .replace('0', '2')
            .replace('O', 'Q')
            .replace('1', 'L')
            .replace('I', 'J')
        return cleaned.take(LENGTH)
    }

    fun isValid(code: String): Boolean {
        if (code.length != LENGTH) return false
        for (c in code) if (c !in ALPHABET) return false
        return true
    }

    fun format(code: String): String {
        val clean = normalize(code)
        if (clean.length <= 3) return clean
        // Mirror JS String.prototype.slice clamping (short codes stay valid).
        return clean.substring(0, 3) + "-" + clean.substring(3, minOf(clean.length, 6))
    }
}
