package com.airbridge.app

import android.content.Context
import android.content.SharedPreferences
import com.airbridge.engine.PairingLink

/**
 * Shell settings: which computer this phone is paired with, plus the loopback
 * port the relay prefers.
 *
 * The port matters: it is part of the WebView origin, and the web app keeps its
 * device identity, theme and pair code in `localStorage` for that origin. Reusing
 * the same port across launches therefore keeps this phone recognisable to the
 * desktop instead of looking like a new device every time.
 */
class Prefs(context: Context) {
    private val sp: SharedPreferences =
        context.getSharedPreferences("airbridge", Context.MODE_PRIVATE)

    /**
     * Base URL of the paired computer (`https://192.168.1.5:3411`), or empty when
     * the phone has never paired. Old builds stored a `ws://…/ws` endpoint here,
     * which [PairingLink] still understands.
     */
    var target: String
        get() = (sp.getString("target", null) ?: sp.getString("serverUrl", null) ?: "").trim()
        set(value) {
            sp.edit().putString("target", value).remove("serverUrl").apply()
        }

    /** The pair code from the last scanned QR (shown on the connect screen). */
    var pairCode: String
        get() = sp.getString("pairCode", "") ?: ""
        set(value) = sp.edit().putString("pairCode", value).apply()

    /**
     * A freshly scanned code that the next page load should claim. Consumed once:
     * replaying a code the user rotated away from days ago would drag the phone
     * back into a stale pairing group, so later loads rely on the web app's own
     * stored code instead.
     */
    var pendingPairCode: String
        get() = sp.getString("pendingPairCode", "") ?: ""
        set(value) = sp.edit().putString("pendingPairCode", value).apply()

    /** Returns the code to append to the next page load, if any. */
    fun consumePendingPairCode(): String? {
        val code = pendingPairCode
        if (code.isEmpty()) return null
        pendingPairCode = ""
        return code
    }

    /**
     * Background clipboard/connection is on by default after pairing. An
     * explicit opt-out is persisted, so reopening Settings cannot silently
     * re-enable it. Android may still pause clipboard reads while hidden.
     */
    var connectionContinuity: Boolean
        get() = sp.getBoolean("connectionContinuity", true)
        set(value) = sp.edit().putBoolean("connectionContinuity", value).apply()

    /**
     * Accessibility-assisted hidden clipboard capture is OFF by default. The
     * user must explicitly opt in, then enable the AirBridge service in
     * Android's Accessibility settings; the app cannot enable it silently.
     */
    var accessibilityClipboardOptIn: Boolean
        get() = sp.getBoolean("accessibilityClipboardOptIn", false)
        set(value) = sp.edit().putBoolean("accessibilityClipboardOptIn", value).apply()

    /** Last working loopback port; 0 until the relay has run once. */
    var relayPort: Int
        get() = sp.getInt("relayPort", 0)
        set(value) = sp.edit().putInt("relayPort", value).apply()

    /** The paired computer, or null when this phone is unpaired. */
    fun pairingLink(): PairingLink? = PairingLink.parse(target)

    var deviceId: String
        get() = sp.getString("nativeDeviceId", null) ?: com.airbridge.engine.AirCrypto.randomHex16().also { deviceId = it }
        set(value) = sp.edit().putString("nativeDeviceId", value).apply()
    var peerId: String
        get() = sp.getString("nativePeerId", "") ?: ""
        set(value) = sp.edit().putString("nativePeerId", value).apply()
    var deviceName: String
        get() = sp.getString("nativeDeviceName", android.os.Build.MODEL) ?: "Android"
        set(value) = sp.edit().putString("nativeDeviceName", value).apply()
    var visibility: String
        get() = sp.getString("nativeVisibility", "nearby") ?: "nearby"
        set(value) = sp.edit().putString("nativeVisibility", value).apply()
    var autoClipboard: Boolean
        get() = sp.getBoolean("nativeAutoClipboard", true)
        set(value) = sp.edit().putBoolean("nativeAutoClipboard", value).apply()
    var receiveClipboard: Boolean
        get() = sp.getBoolean("nativeReceiveClipboard", true)
        set(value) = sp.edit().putBoolean("nativeReceiveClipboard", value).apply()
    var trustedKeys: Set<String>
        get() = sp.getStringSet("nativeTrustedKeys", emptySet())?.toSet() ?: emptySet()
        set(value) = sp.edit().putStringSet("nativeTrustedKeys", value).apply()

    private fun tlsKey(link: PairingLink) = "tlsAnchor:" + link.authority.lowercase(java.util.Locale.ROOT)

    fun tlsTrust(link: PairingLink): com.airbridge.engine.PinnedTlsTrust = com.airbridge.engine.PinnedTlsTrust(
        loadAnchor = { sp.getString(tlsKey(link), null)?.let { android.util.Base64.decode(it, android.util.Base64.NO_WRAP) } },
        saveAnchor = { certificate ->
            check(sp.edit().putString(tlsKey(link), android.util.Base64.encodeToString(certificate, android.util.Base64.NO_WRAP)).commit()) {
                "Could not save the computer's TLS identity"
            }
        },
    )

    fun forget() {
        pairingLink()?.let { sp.edit().remove(tlsKey(it)).commit() }
        sp.edit()
            .remove("target")
            .remove("nativeTrustedKeys")
            .remove("nativePeerId")
            .remove("serverUrl")
            .remove("pairCode")
            .remove("pendingPairCode")
            .remove("accessibilityClipboardOptIn")
            .apply()
    }
}
