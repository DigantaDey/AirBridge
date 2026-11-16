package com.airbridge.engine

/** Turn common network failures into a useful, bounded recovery hint for the app UI. */
object ConnectionHelp {
    private val unreachable = Regex(
        "failed to connect|socket closed|timed out|timeout|connection refused|network is unreachable|no route to host",
        RegexOption.IGNORE_CASE,
    )

    fun message(raw: String): String {
        val safe = raw.trim().take(320)
        return if (unreachable.containsMatchIn(safe)) {
            "Can't reach this computer. Put your phone and computer on the same Wi-Fi, keep AirBridge open on the computer, and scan its current QR code again if the network or address changed."
        } else {
            safe.ifEmpty { "Connection failed. Check the address and try again." }
        }
    }
}
