package com.airbridge.app

import android.content.Context
import android.content.SharedPreferences

/**
 * Persistent app settings. The transfer engine (and the device identity it
 * derived) now lives entirely inside the web client the WebView runs, so the
 * only thing the shell needs to remember is which AirBridge server to open.
 */
class Prefs(context: Context) {
    private val sp: SharedPreferences =
        context.getSharedPreferences("airbridge", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("serverUrl", "") ?: ""
        set(v) = sp.edit().putString("serverUrl", v).apply()
}
