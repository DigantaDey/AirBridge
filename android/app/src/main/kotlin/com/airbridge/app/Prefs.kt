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
     * Invitation state (target, QR alternates, TLS pin, staged/saved pair
     * code, learned endpoints). Lives in the engine module so the exact
     * scan → stage → bootstrap sequence is covered by JVM tests.
     */
    val invitations = com.airbridge.engine.PairingInvitationStore(object : com.airbridge.engine.KeyValueStore {
        override fun getString(key: String): String? = sp.getString(key, null)
        override fun putString(key: String, value: String) { sp.edit().putString(key, value).apply() }
        override fun remove(key: String) { sp.edit().remove(key).apply() }
        override fun commitString(key: String, value: String): Boolean = sp.edit().putString(key, value).commit()
    })

    /**
     * Base URL of the paired computer (`https://192.168.1.5:3411`), or empty when
     * the phone has never paired. Old builds stored a `ws://…/ws` endpoint here,
     * which [PairingLink] still understands. Set it via [stageInvitation].
     */
    val target: String get() = invitations.target

    /** The pair code from the last scanned QR (shown on the connect screen). */
    var pairCode: String
        get() = invitations.pairCode
        set(value) { invitations.pairCode = value }

    /**
     * A freshly scanned code that the next engine start must claim. Consumed
     * once: replaying a code the user rotated away from days ago would drag the
     * phone back into a stale pairing group.
     */
    val pendingPairCode: String get() = invitations.pendingPairCode

    /** Replace the whole previous invitation (code, alternates, pin, learned endpoints). */
    fun stageInvitation(link: PairingLink) = invitations.stage(link)

    fun consumePendingPairCode(): String? = invitations.consumePendingPairCode()

    /**
     * Background clipboard/connection is on by default after pairing. An
     * explicit opt-out is persisted, so reopening Settings cannot silently
     * re-enable it. Android may still pause clipboard reads while hidden.
     */
    var connectionContinuity: Boolean
        get() = sp.getBoolean("connectionContinuity", true)
        set(value) = sp.edit().putBoolean("connectionContinuity", value).apply()

    var notificationSharing: Boolean
        get() = sp.getBoolean("notificationSharing", true)
        set(value) = sp.edit().putBoolean("notificationSharing", value).apply()

    /**
     * Phone continuity toggles. Each feature is only advertised to the computer
     * when its toggle is on AND Android granted the matching permission.
     * Screen sharing additionally asks for consent on every session.
     */
    var contactsOnComputer: Boolean
        get() = sp.getBoolean("contactsOnComputer", true)
        set(value) = sp.edit().putBoolean("contactsOnComputer", value).apply()

    var callsFromComputer: Boolean
        get() = sp.getBoolean("callsFromComputer", true)
        set(value) = sp.edit().putBoolean("callsFromComputer", value).apply()

    var screenSharing: Boolean
        get() = sp.getBoolean("screenSharing", true)
        set(value) = sp.edit().putBoolean("screenSharing", value).apply()

    /**
     * Accessibility-assisted hidden clipboard capture is OFF by default. The
     * user must explicitly opt in, then enable the AirBridge service in
     * Android's Accessibility settings; the app cannot enable it silently.
     */
    val hasAccessibilityClipboardOptInChoice: Boolean
        get() = sp.contains("accessibilityClipboardOptIn")

    var accessibilityClipboardOptIn: Boolean
        get() = sp.getBoolean("accessibilityClipboardOptIn", false)
        set(value) = sp.edit().putBoolean("accessibilityClipboardOptIn", value).apply()

    /** Last working loopback port; 0 until the relay has run once. */
    var relayPort: Int
        get() = sp.getInt("relayPort", 0)
        set(value) = sp.edit().putInt("relayPort", value).apply()

    /** The paired computer (with QR alternates and pin), or null when this phone is unpaired. */
    fun pairingLink(): PairingLink? = invitations.link()

    var deviceId: String
        @Synchronized
        get() = sp.getString("nativeDeviceId", null) ?: com.airbridge.engine.AirCrypto.randomHex16().also {
            sp.edit().putString("nativeDeviceId", it).apply()
        }
        @Synchronized
        set(value) = sp.edit().putString("nativeDeviceId", value).apply()
    var peerId: String
        get() = sp.getString("nativePeerId", "") ?: ""
        set(value) = sp.edit().putString("nativePeerId", value).apply()
    var deviceName: String
        get() = sp.getString("nativeDeviceName", android.os.Build.MODEL) ?: "Android"
        set(value) = sp.edit().putString("nativeDeviceName", value).apply()
    var visibility: String
        get() = normalizeVisibility(sp.getString("nativeVisibility", "nearby"))
        set(value) = sp.edit().putString("nativeVisibility", normalizeVisibility(value)).apply()

    companion object {
        fun normalizeVisibility(mode: String?): String = when (mode) {
            "paired", "paired-only" -> "paired-only"
            "hidden" -> "hidden"
            else -> "nearby"
        }
    }
    var autoClipboard: Boolean
        get() = sp.getBoolean("nativeAutoClipboard", true)
        set(value) = sp.edit().putBoolean("nativeAutoClipboard", value).apply()
    var receiveClipboard: Boolean
        get() = sp.getBoolean("nativeReceiveClipboard", true)
        set(value) = sp.edit().putBoolean("nativeReceiveClipboard", value).apply()
    var themeMode: String
        get() = sp.getString("nativeThemeMode", "dark") ?: "dark"
        set(value) = sp.edit().putString("nativeThemeMode", value).apply()
    var trustedKeys: Set<String>
        get() = sp.getStringSet("nativeTrustedKeys", emptySet())?.toSet() ?: emptySet()
        set(value) = sp.edit().putStringSet("nativeTrustedKeys", value).apply()

    /**
     * Relay route from the last code-authenticated welcome
     * ([com.airbridge.engine.RelayRoute.serialize]); includes the TLS pin it
     * must lead to.
     */
    var relayRoute: String?
        get() = sp.getString("nativeRelayRoute", null)
        set(value) = sp.edit().apply { if (value == null) remove("nativeRelayRoute") else putString("nativeRelayRoute", value) }.apply()

    /**
     * Hotspot handoff keys from the last code-authenticated welcome
     * ([com.airbridge.engine.Handoff.Info]): the computer's offer key and
     * Bluetooth tag secret. Kept so a hotspot can be handed over with no
     * network at all. Proof already verified when saved.
     */
    var handoffInfo: com.airbridge.engine.Handoff.Info?
        get() = com.airbridge.engine.Handoff.Info.parse(sp.getString("nativeHandoffInfo", null))
        set(value) = sp.edit().apply { if (value == null) remove("nativeHandoffInfo") else putString("nativeHandoffInfo", value.toJson()) }.apply()

    fun tlsTrust(link: PairingLink): com.airbridge.engine.PinnedTlsTrust = invitations.tlsTrust(link)

    fun forget() {
        invitations.forget()
        sp.edit()
            .remove("nativeTrustedKeys")
            .remove("nativePeerId")
            .remove("nativeRelayRoute")
            .remove("nativeHandoffInfo")
            .apply()
    }
}
