package com.airbridge.engine

import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Trust on first use for a LAN server's persistent local CA (or self-signed
 * leaf). Unlike trust-all, subsequent handshakes must chain to that exact
 * anchor. Pin the CA, not a generated leaf: the desktop renews its leaf when
 * its LAN IP changes. The socket must also enable HTTPS hostname validation.
 *
 * The first connection is NOT authenticated out of band. Users must compare
 * the E2EE SAS before trusting peers. Resetting a pin is an explicit unpair.
 */
class PinnedTlsTrust(
    private val loadAnchor: () -> ByteArray?,
    private val saveAnchor: (ByteArray) -> Unit,
) : X509TrustManager {
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not supported")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        if (chain.isNullOrEmpty()) throw CertificateException("TLS server sent no certificate")
        // Serialize the load/check/save transaction across UI and service
        // sockets, including distinct trust-manager instances for one target.
        synchronized(pinLock) {
            val saved = loadAnchor()
            val anchor = if (saved == null) chain.last() else {
                CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(saved)) as X509Certificate
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
                throw CertificateException(if (saved != null)
                    "AirBridge TLS identity changed or expired. Verify your computer, then Forget computer and scan its QR again."
                    else "Invalid AirBridge TLS certificate", e)
            }
            // Never persist a chain that failed cryptographic validation.
            if (saved == null) saveAnchor(anchor.encoded)
        }
    }

    private companion object { val pinLock = Any() }
}
