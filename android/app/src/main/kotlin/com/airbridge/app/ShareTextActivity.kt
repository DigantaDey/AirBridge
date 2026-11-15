package com.airbridge.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast

/** Explicit Share / selected-text action: works when Android hides clipboard reads. */
class ShareTextActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val action = intent?.action
        val raw = when (action) {
            Intent.ACTION_SEND -> {
                val text = intent?.getCharSequenceExtra(Intent.EXTRA_TEXT)
                if (text != null) text
                else if (intent?.type?.startsWith("text/") == true) intent?.getStringExtra(Intent.EXTRA_TEXT)
                else null
            }
            Intent.ACTION_PROCESS_TEXT -> intent?.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)
            else -> null
        }?.toString().orEmpty()
        if (Prefs(this).pairingLink() == null) {
            runCatching {
                Toast.makeText(this, "Pair AirBridge with your computer first", Toast.LENGTH_LONG).show()
                startActivity(Intent(this, MainActivity::class.java).setPackage(packageName))
            }
        } else if (raw.length > com.airbridge.engine.Limits.MAX_CLIPBOARD_TEXT) {
            runCatching { Toast.makeText(this, "Text exceeds clipboard limit", Toast.LENGTH_SHORT).show() }
        } else if (raw.isBlank()) {
            runCatching { Toast.makeText(this, "No text to share", Toast.LENGTH_SHORT).show() }
        } else {
            val dispatched = ConnectionService.publishClipboardOrStart(this, raw, explicit = true)
            if (dispatched) {
                runCatching { Toast.makeText(this, "Sending to your paired computer", Toast.LENGTH_SHORT).show() }
            } else {
                runCatching {
                    val command = Intent(this, ConnectionService::class.java)
                        .setPackage(packageName)
                        .setAction(ConnectionService.ACTION_SHARE_TEXT)
                        .putExtra(ConnectionService.EXTRA_CLIPBOARD_TEXT, raw)
                    startForegroundService(command)
                    Toast.makeText(this, "Sending to your paired computer", Toast.LENGTH_SHORT).show()
                }.onFailure {
                    runCatching { Toast.makeText(this, "Open AirBridge to reconnect, then share again", Toast.LENGTH_LONG).show() }
                }
            }
        }
        finish()
    }
}
