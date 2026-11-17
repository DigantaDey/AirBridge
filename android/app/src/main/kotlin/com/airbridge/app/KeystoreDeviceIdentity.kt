package com.airbridge.app

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import com.airbridge.engine.AirCrypto
import com.airbridge.engine.DeviceIdentity
import com.airbridge.engine.SoftwareDeviceIdentity
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * This phone's long-term AirBridge identity: a P-256 key that never leaves
 * the Android Keystore (StrongBox when the device has one). It signs each
 * session's ephemeral key, so computers can pin *this phone* across restarts
 * without weakening forward secrecy.
 */
class KeystoreDeviceIdentity private constructor(
    private val privateKey: PrivateKey,
    override val publicKeyRaw: ByteArray,
) : DeviceIdentity {
    override val persistent: Boolean = true

    override fun signDer(message: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(message)
            sign()
        }

    companion object {
        private const val TAG = "AirBridgeIdentity"
        private const val ALIAS = "airbridge-device-identity-v1"

        /** Keystore identity, or a private-file software key on devices whose keystore is broken. */
        fun load(context: Context): DeviceIdentity =
            runCatching { loadKeystore() }
                .onFailure { Log.w(TAG, "Android Keystore unavailable, using a file-backed identity: ${it.message}") }
                .getOrElse { SoftwareDeviceIdentity(File(context.noBackupFilesDir, "airbridge-identity")) }

        private fun loadKeystore(): DeviceIdentity {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val existing = (ks.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry)
            val entry = existing ?: run {
                generate(strongBox = Build.VERSION.SDK_INT >= 28)
                ks.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
            }
            val pub = entry.certificate.publicKey as ECPublicKey
            return KeystoreDeviceIdentity(entry.privateKey, AirCrypto.rawPublicKey(pub))
        }

        private fun generate(strongBox: Boolean) {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .apply { if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true) }
                .build()
            try {
                KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
                    initialize(spec)
                    generateKeyPair()
                }
            } catch (e: Exception) {
                // StrongBoxUnavailableException (API 28+) and vendor quirks: retry in the TEE.
                if (strongBox) generate(strongBox = false) else throw e
            }
        }
    }
}
