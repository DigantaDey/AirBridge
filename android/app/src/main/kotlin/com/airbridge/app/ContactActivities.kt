package com.airbridge.app

import android.app.Activity
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.widget.Toast
import com.airbridge.engine.ContactCard
import com.airbridge.engine.Continuity
import com.airbridge.engine.VCard
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.Executors

/**
 * Saves contact cards received from the computer through the system contact
 * editor (ACTION_INSERT): the user reviews each card and picks the account, so
 * AirBridge never needs WRITE_CONTACTS.
 */
class ContactImportActivity : Activity() {
    private var cards: List<ContactCard> = emptyList()
    private var index = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cards = VCard.parse(intent?.getStringExtra(EXTRA_VCARD).orEmpty()).take(MAX_CARDS)
        index = savedInstanceState?.getInt(STATE_INDEX) ?: 0
        if (cards.isEmpty()) {
            runCatching { Toast.makeText(this, "That contact card is empty", Toast.LENGTH_SHORT).show() }
            finish()
            return
        }
        if (savedInstanceState == null) next()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt(STATE_INDEX, index)
    }

    private fun next() {
        if (index >= cards.size) {
            finish()
            return
        }
        val intent = insertIntent(cards[index])
        index++
        runCatching {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQUEST_INSERT)
        }.onFailure {
            runCatching { Toast.makeText(this, "No contacts app is available to save this card", Toast.LENGTH_LONG).show() }
            finish()
        }
    }

    @Deprecated("Platform Activity result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_INSERT) next()
    }

    companion object {
        const val EXTRA_VCARD = "vcard"
        private const val STATE_INDEX = "index"
        private const val REQUEST_INSERT = 0xC0
        private const val MAX_CARDS = 20

        fun insertIntent(card: ContactCard): Intent {
            val intent = Intent(ContactsContract.Intents.Insert.ACTION)
                .setType(ContactsContract.RawContacts.CONTENT_TYPE)
                .putExtra("finishActivityOnSaveCompleted", true)
                .putExtra(ContactsContract.Intents.Insert.NAME, card.name)
            card.organization?.let { intent.putExtra(ContactsContract.Intents.Insert.COMPANY, it) }
            card.note?.let { intent.putExtra(ContactsContract.Intents.Insert.NOTES, it) }
            // Data rows carry every number/address with its type (the legacy
            // PHONE/SECONDARY_PHONE extras stop at three).
            val rows = ArrayList<ContentValues>()
            for (p in card.phones) {
                rows.add(
                    ContentValues().apply {
                        put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                        put(ContactsContract.CommonDataKinds.Phone.NUMBER, p.number)
                        put(ContactsContract.CommonDataKinds.Phone.TYPE, phoneType(p.label))
                    },
                )
            }
            for (e in card.emails) {
                rows.add(
                    ContentValues().apply {
                        put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
                        put(ContactsContract.CommonDataKinds.Email.ADDRESS, e.address)
                        put(
                            ContactsContract.CommonDataKinds.Email.TYPE,
                            when (e.label) {
                                "home" -> ContactsContract.CommonDataKinds.Email.TYPE_HOME
                                "work" -> ContactsContract.CommonDataKinds.Email.TYPE_WORK
                                else -> ContactsContract.CommonDataKinds.Email.TYPE_OTHER
                            },
                        )
                    },
                )
            }
            if (rows.isNotEmpty()) intent.putParcelableArrayListExtra(ContactsContract.Intents.Insert.DATA, rows)
            return intent
        }

        private fun phoneType(label: String?): Int = when (label?.lowercase()) {
            "mobile", "cell" -> ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE
            "home" -> ContactsContract.CommonDataKinds.Phone.TYPE_HOME
            "work" -> ContactsContract.CommonDataKinds.Phone.TYPE_WORK
            "main" -> ContactsContract.CommonDataKinds.Phone.TYPE_MAIN
            "fax" -> ContactsContract.CommonDataKinds.Phone.TYPE_FAX_WORK
            "pager" -> ContactsContract.CommonDataKinds.Phone.TYPE_PAGER
            else -> ContactsContract.CommonDataKinds.Phone.TYPE_OTHER
        }
    }
}

/**
 * "Share contact → AirBridge" from any contacts app (text/x-vcard): parses the
 * vCard off the main thread, rejects non-`content://` or self-owned provider URIs,
 * starts [ConnectionService] if paired, and sends the cards over the encrypted session.
 */
class ShareContactActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appContext = applicationContext
        val ownPackage = packageName
        val incoming = intent
        val inlineText = incoming?.getStringExtra(Intent.EXTRA_TEXT)
            ?.takeIf { it.contains("BEGIN:VCARD", ignoreCase = true) }
        val streamUri: Uri? = if (inlineText == null && incoming != null) {
            (if (Build.VERSION.SDK_INT >= 33) incoming.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") incoming.getParcelableExtra(Intent.EXTRA_STREAM)) ?: incoming.data
        } else {
            null
        }

        if (inlineText == null && streamUri != null) {
            if (!isAllowedShareUri(streamUri.scheme, streamUri.authority, ownPackage)) {
                AndroidDiagnostics.recordEvent(
                    "shareContact",
                    "Rejected disallowed URI scheme=${streamUri.scheme} authority=${streamUri.authority}",
                    "WARN",
                )
                runCatching {
                    Toast.makeText(this, "Cannot read contact from that source", Toast.LENGTH_SHORT).show()
                }
                finish()
                return
            }
        }

        // Hold a short-lived reference to the ContentResolver; stream reading and
        // engine submission run asynchronously on shareExecutor so onCreate never blocks.
        val resolver = contentResolver
        shareExecutor.execute {
            val startMs = System.currentTimeMillis()
            val message = runCatching {
                shareAsync(appContext, resolver, ownPackage, inlineText, streamUri)
            }.getOrElse { err ->
                AndroidDiagnostics.recordEvent("shareContact", "Share failed: ${err.message}", "WARN")
                err.message ?: "Could not share the contact"
            }
            val elapsedMs = System.currentTimeMillis() - startMs
            AndroidDiagnostics.recordEvent("shareContact", "Completed in ${elapsedMs}ms: $message")
            mainHandler.post {
                runCatching { Toast.makeText(appContext, message, Toast.LENGTH_LONG).show() }
            }
        }
        finish()
    }

    companion object {
        private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
        private val shareExecutor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "airbridge-share-contact").apply { isDaemon = true }
        }

        /**
         * Rejects `file://` (or any non-`content://` scheme) and any URI whose
         * authority belongs to AirBridge itself (`${ownPackageName}` or `${ownPackageName}.*`),
         * preventing Confused Deputy reads of private app files or ClipboardImageProvider.
         */
        fun isAllowedShareUri(scheme: String?, authority: String?, ownPackageName: String): Boolean {
            if (!scheme.equals("content", ignoreCase = true)) return false
            val auth = authority?.trim()?.lowercase().orEmpty()
            if (auth.isEmpty()) return false
            val userStrippedAuth = auth.substringAfterLast('@')
            val pkg = ownPackageName.trim().lowercase()
            if (pkg.isNotEmpty() && (userStrippedAuth == pkg || userStrippedAuth.startsWith("$pkg."))) {
                return false
            }
            return true
        }

        private fun shareAsync(
            appContext: Context,
            resolver: ContentResolver,
            ownPackage: String,
            inlineText: String?,
            streamUri: Uri?,
        ): String {
            val text = readVCard(resolver, ownPackage, inlineText, streamUri)
                ?: return "No contact card to share"
            val cards = VCard.parse(text)
            if (cards.isEmpty()) return "That contact card could not be read"

            var host = NativeEngineHost.instance
            if (host == null && Prefs(appContext).target.isNotEmpty()) {
                runCatching {
                    val startIntent = Intent(appContext, ConnectionService::class.java)
                        .setPackage(appContext.packageName)
                        .setAction(ConnectionService.ACTION_START)
                    appContext.startForegroundService(startIntent)
                }
                val deadline = System.currentTimeMillis() + 2_500L
                while (host == null && System.currentTimeMillis() < deadline) {
                    Thread.sleep(100L)
                    host = NativeEngineHost.instance
                }
            }
            val activeHost = host ?: return "Open AirBridge and connect to your computer first"
            val sent = activeHost.shareContacts(cards)
            return when {
                sent.isFailure -> sent.exceptionOrNull()?.message ?: "Could not share the contact"
                cards.size == 1 -> "Sent ${cards[0].name} to ${sent.getOrNull()}"
                else -> "Sent ${cards.size} contacts to ${sent.getOrNull()}"
            }
        }

        private fun readVCard(
            resolver: ContentResolver,
            ownPackage: String,
            inlineText: String?,
            streamUri: Uri?,
        ): String? {
            if (inlineText != null) return inlineText
            val uri = streamUri ?: return null
            require(isAllowedShareUri(uri.scheme, uri.authority, ownPackage)) {
                "Cannot read contact from that source"
            }
            return resolver.openInputStream(uri)?.use { input ->
                val bytes = input.readNBytesCompat(Continuity.MAX_VCARD_LENGTH + 1)
                require(bytes.size <= Continuity.MAX_VCARD_LENGTH) { "Too many contacts to share at once" }
                String(bytes, Charsets.UTF_8)
            }
        }

        internal fun InputStream.readNBytesCompat(limit: Int): ByteArray {
            val out = ByteArrayOutputStream()
            val buf = ByteArray(8192)
            while (out.size() < limit) {
                val n = read(buf, 0, minOf(buf.size, limit - out.size()))
                if (n < 0) break
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        }
    }
}
