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

    var connectionContinuity: Boolean
        get() = sp.getBoolean("connectionContinuity", false)
        set(value) = sp.edit().putBoolean("connectionContinuity", value).apply()

    /** Last working loopback port; 0 until the relay has run once. */
    var relayPort: Int
        get() = sp.getInt("relayPort", 0)
        set(value) = sp.edit().putInt("relayPort", value).apply()

    /** The paired computer, or null when this phone is unpaired. */
    fun pairingLink(): PairingLink? = PairingLink.parse(target)

    fun forget() {
        sp.edit().remove("target").remove("serverUrl").remove("pairCode").remove("pendingPairCode").apply()
    }
}
