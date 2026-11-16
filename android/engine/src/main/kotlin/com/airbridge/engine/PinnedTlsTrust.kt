package com.airbridge.engine

import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Pins a LAN server's persistent local CA (or self-signed leaf). Unlike
 * trust-all, every handshake must chain to that exact anchor. Pin the CA, not
 * a generated leaf: the desktop renews its leaf when its LAN IP changes. The
 * socket must also enable HTTPS hostname validation.
 *
 * Two modes:
 *  - [expectedPinSha256] set (current QRs carry `ca=`): the anchor is
 *    authenticated by the QR the user physically scanned. The chain must end
 *    in a certificate with that SHA-256, on the first connection too. Because
 *    the pin identifies the computer rather than an address, it is safe to
 *    reuse across all of the computer's candidate addresses.
 *  - no expected pin (older desktop builds): trust on first use. The first
 *    connection is NOT authenticated out of band; users must compare the E2EE
 *    SAS before trusting peers. Resetting a pin is an explicit unpair.
 */
class PinnedTlsTrust(
    private val loadAnchor: () -> ByteArray?,
    private val saveAnchor: (ByteArray) -> Unit,
    private val expectedPinSha256: String? = null,
) : X509TrustManager {
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

    /**
     * True when the computer's identity is fixed (QR pin or a saved anchor),
     * i.e. trust is never decided by whoever answers first. Required before the
     * phone accepts reverse connections: an unanchored trust-on-first-use
     * would let any LAN host that dials the phone become "the computer".
     */
    fun isAnchored(): Boolean =
        expectedPinSha256?.let { PairingLink.isValidPin(it) } == true ||
            runCatching { loadAnchor() != null }.getOrDefault(false)
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not supported")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        if (chain.isNullOrEmpty()) throw CertificateException("TLS server sent no certificate")
        // Serialize the load/check/save transaction across UI and service
        // sockets, including distinct trust-manager instances for one target.
        synchronized(pinLock) {
            val expected = expectedPinSha256?.takeIf { PairingLink.isValidPin(it) }
            val saved = loadAnchor()
            val anchor: X509Certificate = when {
                expected != null -> {
                    val last = chain.last()
                    if (pinOf(last.encoded) != expected) {
                        throw CertificateException("The computer's TLS certificate does not match the QR code you scanned")
                    }
                    last
                }
                saved == null -> chain.last()
                else -> CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(saved)) as X509Certificate
            }
            val keys = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                load(null, null)
                setCertificateEntry("airbridge", anchor)
            }
            val manager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keys) }
                .trustManagers.filterIsInstance<X509TrustManager>().first()
            try {
                chain.forEach { it.checkValidity() }
                anchor.checkValidity()
                manager.checkServerTrusted(chain, authType ?: chain.first().publicKey.algorithm)
            } catch (e: Exception) {
                throw CertificateException(if (saved != null && expected == null)
                    "AirBridge TLS identity changed or expired. Verify your computer, then Forget computer and scan its QR again."
                    else "Invalid AirBridge TLS certificate", e)
            }
            // Never persist a chain that failed cryptographic validation. A
            // QR-authenticated anchor replaces an older TOFU pin: the user
            // just scanned this computer's screen.
            if (saved == null || (expected != null && !saved.contentEquals(anchor.encoded))) saveAnchor(anchor.encoded)
        }
    }

    companion object {
        private val pinLock = Any()

        /** base64url (no padding) SHA-256 of a DER certificate — the QR `ca=` format. */
        fun pinOf(der: ByteArray): String =
            Base64Url.encode(MessageDigest.getInstance("SHA-256").digest(der))
    }
}
