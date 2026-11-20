package com.airbridge.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import com.airbridge.app.ShareContactActivity.Companion.readNBytesCompat
import com.airbridge.engine.Limits
import java.util.concurrent.Executors

/** Explicit Share / selected-text action: works when Android hides clipboard reads. */
class ShareTextActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val incoming = intent
        val action = incoming?.action
        if (Prefs(this).pairingLink() == null) {
            runCatching {
                Toast.makeText(this, "Pair AirBridge with your computer first", Toast.LENGTH_LONG).show()
                startActivity(Intent(this, MainActivity::class.java).setPackage(packageName))
            }
            finish()
            return
        }

        val inlineText = when (action) {
            Intent.ACTION_SEND -> {
                val text = incoming.getCharSequenceExtra(Intent.EXTRA_TEXT)
                if (text != null) text.toString()
                else if (incoming.type?.startsWith("text/") == true) incoming.getStringExtra(Intent.EXTRA_TEXT)
                else null
            }
            Intent.ACTION_PROCESS_TEXT -> incoming.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
            else -> null
        }

        if (inlineText != null) {
            dispatchSharedText(this, inlineText)
            finish()
            return
        }

        val streamUri: Uri? = if (action == Intent.ACTION_SEND) {
            (if (Build.VERSION.SDK_INT >= 33) incoming.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") incoming.getParcelableExtra(Intent.EXTRA_STREAM)) ?: incoming.data
        } else {
            null
        }

        if (streamUri == null) {
            runCatching { Toast.makeText(this, "No text to share", Toast.LENGTH_SHORT).show() }
            finish()
            return
        }

        val ownPackage = packageName
        if (!ShareContactActivity.isAllowedShareUri(streamUri.scheme, streamUri.authority, ownPackage)) {
            AndroidDiagnostics.recordEvent(
                "shareText",
                "Rejected disallowed URI scheme=${streamUri.scheme} authority=${streamUri.authority}",
                "WARN",
            )
            runCatching { Toast.makeText(this, "Cannot read text from that source", Toast.LENGTH_SHORT).show() }
            finish()
            return
        }

        val appContext = applicationContext
        val resolver = contentResolver
        streamExecutor.execute {
            val loaded = runCatching {
                resolver.openInputStream(streamUri)?.use { input ->
                    val bytes = input.readNBytesCompat(Limits.MAX_CLIPBOARD_TEXT + 1)
                    String(bytes, Charsets.UTF_8)
                }
            }.getOrNull()
            mainHandler.post {
                dispatchSharedText(appContext, loaded.orEmpty())
            }
        }
        finish()
    }

    companion object {
        private val mainHandler = Handler(Looper.getMainLooper())
        private val streamExecutor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "airbridge-share-text").apply { isDaemon = true }
        }

        private fun dispatchSharedText(context: Context, raw: String) {
            when {
                raw.length > Limits.MAX_CLIPBOARD_TEXT -> {
                    runCatching { Toast.makeText(context, "Text exceeds clipboard limit", Toast.LENGTH_SHORT).show() }
                }
                raw.isBlank() -> {
                    runCatching { Toast.makeText(context, "No text to share", Toast.LENGTH_SHORT).show() }
                }
                else -> {
                    val dispatched = ConnectionService.publishClipboardOrStart(context, raw, explicit = true)
                    if (dispatched) {
                        runCatching { Toast.makeText(context, "Sending to your paired computer", Toast.LENGTH_SHORT).show() }
                    } else {
                        runCatching {
                            val command = Intent(context, ConnectionService::class.java)
                                .setPackage(context.packageName)
                                .setAction(ConnectionService.ACTION_SHARE_TEXT)
                                .putExtra(ConnectionService.EXTRA_CLIPBOARD_TEXT, raw)
                            context.startForegroundService(command)
                            Toast.makeText(context, "Sending to your paired computer", Toast.LENGTH_SHORT).show()
                        }.onFailure {
                            runCatching { Toast.makeText(context, "Open AirBridge to reconnect, then share again", Toast.LENGTH_LONG).show() }
                        }
                    }
                }
            }
        }
    }
}
