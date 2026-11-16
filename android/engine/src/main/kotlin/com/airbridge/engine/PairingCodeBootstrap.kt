package com.airbridge.engine

/**
 * Resolve the code used by the next native connection. A freshly scanned code
 * takes precedence over persisted state: the QR scanner stores it separately
 * because the target URL is persisted without its query string. Without this
 * ordering a QR scan could silently reconnect using yesterday's pairing code.
 */
object PairingCodeBootstrap {
    fun resolve(pendingScanned: String?, invitation: String?, saved: String?): String =
        pendingScanned?.takeIf { it.isNotBlank() }
            ?: invitation?.takeIf { it.isNotBlank() }
            ?: saved?.takeIf { it.isNotBlank() }
            ?: ""
}
