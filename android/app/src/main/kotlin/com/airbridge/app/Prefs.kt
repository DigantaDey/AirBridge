package com.airbridge.app

import android.content.Context
import android.content.SharedPreferences
import com.airbridge.engine.AirCrypto

/**
 * Persistent engine identity + settings. The peer id/device id survive
 * restarts so the desktop remembers this phone between sessions.
 */
class Prefs(context: Context) {
    private val sp: SharedPreferences =
        context.getSharedPreferences("airbridge", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("serverUrl", "") ?: ""
        set(v) = sp.edit().putString("serverUrl", v).apply()

    var deviceName: String
        get() = sp.getString("deviceName", defaultName) ?: defaultName
        set(v) = sp.edit().putString("deviceName", v).apply()

    var visibility: String
        get() = sp.getString("visibility", "nearby") ?: "nearby"
        set(v) = sp.edit().putString("visibility", v).apply()

    val deviceId: String
        get() = sp.getString("deviceId", null) ?: AirCrypto.randomHex16().also {
            sp.edit().putString("deviceId", it).apply()
        }

    val peerId: String
        get() = sp.getString("peerId", null) ?: AirCrypto.randomHex16().also {
            sp.edit().putString("peerId", it).apply()
        }

    private val defaultName: String
        get() = "Android ${android.os.Build.MODEL ?: "Device"}".take(80)
}
