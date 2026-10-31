package com.airbridge.engine

/**
 * A pairing invitation: the desktop address a phone should talk to, plus the
 * optional six-character pair code baked into the QR the desktop prints.
 *
 * The Android app is a shell around the desktop's web UI, so everything it
 * needs to know to open the UI is "which computer, over which scheme, port and
 * pair code". QRs are produced as `https://<host>:<port>/?pair=ABC-DEF`
 * (see packaging/desktop-entry.ts) but the parser also accepts the
 * `ws://host:port/ws` form older builds printed, bare `host:port` typed by
 * hand, and an `airbridge://` link.
 *
 * Pure JVM: no Android or third-party dependencies, so it is unit-testable.
 */
data class PairingLink(
    /** `http` or `https` — the scheme the desktop serves the web UI on. */
    val scheme: String,
    val host: String,
    val port: Int,
    /** Normalised pair code, or null when the invitation carries none. */
    val pairCode: String?,
) {
    val secure: Boolean get() = scheme == "https"

    /** `host:port`, omitting the default port so URLs look hand-typed. */
    val authority: String get() = if (port == DEFAULT_PORT) host else "$host:$port"

    /** Base URL of the desktop's web UI, e.g. `https://192.168.1.5:3411`. */
    val baseUrl: String get() = "$scheme://$authority"

    /** Signalling endpoint the web UI connects to, e.g. `wss://192.168.1.5:3411/ws`. */
    val wsUrl: String get() = (if (secure) "wss" else "ws") + "://$authority/ws"

    /** The web UI URL, with the pair code attached so the phone auto-joins. */
    fun webUrl(code: String? = pairCode): String =
        if (code == null) "$baseUrl/" else "$baseUrl/?pair=$code"

    companion object {
        /** Port the desktop server binds unless told otherwise. */
        const val DEFAULT_PORT = 3411

        /** Parses a scanned QR payload or a manually typed address. Null when unusable. */
        fun parse(raw: String): PairingLink? {
            var text = raw.trim()
            if (text.isEmpty()) return null
            // QR payloads picked up from a terminal can carry a trailing newline
            // and, rarely, surrounding prose. Use the first non-blank line.
            text = text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: return null
            if (text.any { it.isWhitespace() }) return null

            val scheme: String
            val withoutScheme: String
            val schemeEnd = text.indexOf("://")
            if (schemeEnd > 0) {
                val declared = text.substring(0, schemeEnd).lowercase()
                if (!declared.all { it in 'a'..'z' || it in '0'..'9' || it == '+' || it == '-' || it == '.' }) {
                    return null
                }
                scheme = when (declared) {
                    "https", "wss" -> "https"
                    "http", "ws" -> "http"
                    // Not printed today, but a scheme makes the QR unambiguous.
                    "airbridge" -> "http"
                    else -> return null
                }
                withoutScheme = text.substring(schemeEnd + 3)
            } else {
                // A bare "host:port" keeps whatever the user typed; the shell
                // tries TLS first and falls back to plaintext on its own.
                scheme = "https"
                withoutScheme = text.removePrefix("//")
            }

            var rest = withoutScheme
            var fragment = ""
            val hash = rest.indexOf('#')
            if (hash >= 0) {
                fragment = rest.substring(hash + 1)
                rest = rest.substring(0, hash)
            }
            var query = ""
            val question = rest.indexOf('?')
            if (question >= 0) {
                query = rest.substring(question + 1)
                rest = rest.substring(0, question)
            }
            val slash = rest.indexOf('/')
            if (slash >= 0) rest = rest.substring(0, slash)
            val at = rest.lastIndexOf('@')
            if (at >= 0) rest = rest.substring(at + 1)
            if (rest.isEmpty()) return null

            val host: String
            val portText: String
            if (rest.startsWith("[")) {
                val close = rest.indexOf(']')
                if (close < 0) return null
                host = rest.substring(0, close + 1)
                val after = rest.substring(close + 1)
                portText = when {
                    after.isEmpty() -> ""
                    after.startsWith(":") -> after.substring(1)
                    else -> return null
                }
            } else {
                val colon = rest.lastIndexOf(':')
                if (colon >= 0) {
                    host = rest.substring(0, colon)
                    portText = rest.substring(colon + 1)
                } else {
                    host = rest
                    portText = ""
                }
            }
            if (host.isEmpty() || host.contains('\u0000')) return null
            if (host.any { it.isWhitespace() }) return null
            val port = if (portText.isEmpty()) DEFAULT_PORT else portText.toIntOrNull() ?: return null
            if (port !in 1..65535) return null

            val code = pairCodeFrom(query) ?: pairCodeFrom(fragment)
            return PairingLink(scheme = scheme, host = host, port = port, pairCode = code)
        }

        private fun pairCodeFrom(params: String): String? {
            if (params.isEmpty()) return null
            for (part in params.split('&')) {
                val equals = part.indexOf('=')
                val key = (if (equals >= 0) part.substring(0, equals) else part).lowercase()
                if (key != "pair" && key != "paircode" && key != "code") continue
                val value = if (equals >= 0) part.substring(equals + 1) else ""
                val normalized = PairCode.normalize(percentDecode(value))
                if (PairCode.isValid(normalized)) return normalized
            }
            return null
        }

        /** Minimal percent-decoder: pair codes are ASCII, so this is enough. */
        private fun percentDecode(value: String): String {
            if (!value.contains('%') && !value.contains('+')) return value
            val out = StringBuilder(value.length)
            var i = 0
            while (i < value.length) {
                val c = value[i]
                if (c == '+') {
                    out.append(' ')
                    i++
                } else if (c == '%' && i + 2 < value.length) {
                    val hex = value.substring(i + 1, i + 3).toIntOrNull(16)
                    if (hex == null) {
                        out.append(c)
                        i++
                    } else {
                        out.append(hex.toChar())
                        i += 3
                    }
                } else {
                    out.append(c)
                    i++
                }
            }
            return out.toString()
        }
    }
}
