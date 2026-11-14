package com.airbridge.app

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast

/** Explicit Share / selected-text action: works when Android hides clipboard reads. */
class ShareTextActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = when (intent?.action) {
            Intent.ACTION_SEND -> intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_PROCESS_TEXT -> intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)
            else -> null
        }?.toString().orEmpty()
        if (Prefs(this).pairingLink() == null) {
            Toast.makeText(this, "Pair AirBridge with your computer first", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
        } else if (text.isNotBlank() && text.length <= com.airbridge.engine.Limits.MAX_CLIPBOARD_TEXT) {
            try {
                val command = Intent(this, ConnectionService::class.java)
                    .setAction(ConnectionService.ACTION_SHARE_TEXT)
                    .putExtra(ConnectionService.EXTRA_CLIPBOARD_TEXT, text)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(command) else startService(command)
                Toast.makeText(this, "Sending to your paired computer", Toast.LENGTH_SHORT).show()
            } catch (_: Exception) {
                Toast.makeText(this, "Open AirBridge to reconnect, then share again", Toast.LENGTH_LONG).show()
            }
        }
        finish()
    }
}
