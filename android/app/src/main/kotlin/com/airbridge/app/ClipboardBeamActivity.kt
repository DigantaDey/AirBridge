package com.airbridge.app

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/**
 * Brief translucent focus trampoline invoked by explicit user gestures (Quick
 * Settings tile or the "Beam clipboard" notification button) so Android 10+
 * grants window focus for one clipboard read before closing immediately.
 */
class ClipboardBeamActivity : Activity() {
    private var handled = false
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private val timeoutRunnable = Runnable {
        if (!handled && !isFinishing && !isDestroyed) {
            handled = true
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Prefs(this).pairingLink() == null) {
            runCatching {
                Toast.makeText(this, "Pair AirBridge with your computer first", Toast.LENGTH_LONG).show()
                startActivity(Intent(this, MainActivity::class.java).setPackage(packageName))
            }
            handled = true
            finish()
            return
        }
        // Safety timeout: dismiss trampoline if window focus is never granted
        timeoutHandler.postDelayed(timeoutRunnable, 2000L)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || handled || isFinishing || isDestroyed) return
        handled = true
        timeoutHandler.removeCallbacks(timeoutRunnable)
        runCatching {
            val text = ClipboardText.read(this)
            if (text == null) {
                Toast.makeText(this, "Nothing plain to beam in clipboard", Toast.LENGTH_SHORT).show()
            } else {
                val dispatched = ConnectionService.publishClipboardOrStart(this, text, explicit = true)
                if (dispatched) {
                    Toast.makeText(this, "Beamed clipboard to paired computer", Toast.LENGTH_SHORT).show()
                } else {
                    // Force-share via foreground service even if continuity toggle was temporarily off
                    runCatching {
                        val intent = Intent(this, ConnectionService::class.java)
                            .setPackage(packageName)
                            .setAction(ConnectionService.ACTION_SHARE_TEXT)
                            .putExtra(ConnectionService.EXTRA_CLIPBOARD_TEXT, text)
                        startForegroundService(intent)
                        Toast.makeText(this, "Beamed clipboard to paired computer", Toast.LENGTH_SHORT).show()
                    }.onFailure {
                        Toast.makeText(this, "Open AirBridge to reconnect, then try again", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
        finish()
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
            } else {
                @Suppress("DEPRECATION")
                overridePendingTransition(0, 0)
            }
        }
    }

    override fun onDestroy() {
        timeoutHandler.removeCallbacks(timeoutRunnable)
        super.onDestroy()
    }
}
