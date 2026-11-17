package com.airbridge.app

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.ContactsContract
import android.widget.Toast
import com.airbridge.engine.ContactCard
import com.airbridge.engine.VCard

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
                rows.add(ContentValues().apply {
                    put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                    put(ContactsContract.CommonDataKinds.Phone.NUMBER, p.number)
                    put(ContactsContract.CommonDataKinds.Phone.TYPE, phoneType(p.label))
                })
            }
            for (e in card.emails) {
                rows.add(ContentValues().apply {
                    put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
                    put(ContactsContract.CommonDataKinds.Email.ADDRESS, e.address)
                    put(ContactsContract.CommonDataKinds.Email.TYPE, when (e.label) {
                        "home" -> ContactsContract.CommonDataKinds.Email.TYPE_HOME
                        "work" -> ContactsContract.CommonDataKinds.Email.TYPE_WORK
                        else -> ContactsContract.CommonDataKinds.Email.TYPE_OTHER
                    })
                })
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
 * vCard and sends it to every verified computer over the encrypted session.
 */
class ShareContactActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val message = runCatching { share() }.getOrElse { it.message ?: "Could not share the contact" }
        runCatching { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
        finish()
    }

    private fun share(): String {
        val text = readVCard() ?: return "No contact card to share"
        val cards = VCard.parse(text)
        if (cards.isEmpty()) return "That contact card could not be read"
        val host = NativeEngineHost.instance ?: return "Open AirBridge and connect to your computer first"
        val sent = host.shareContacts(cards)
        return when {
            sent.isFailure -> sent.exceptionOrNull()?.message ?: "Could not share the contact"
            cards.size == 1 -> "Sent ${cards[0].name} to ${sent.getOrNull()}"
            else -> "Sent ${cards.size} contacts to ${sent.getOrNull()}"
        }
    }

    private fun readVCard(): String? {
        val i = intent ?: return null
        i.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.contains("BEGIN:VCARD", ignoreCase = true) }?.let { return it }
        val uri: Uri = (if (android.os.Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") i.getParcelableExtra(Intent.EXTRA_STREAM)) ?: i.data ?: return null
        return contentResolver.openInputStream(uri)?.use { input ->
            val bytes = input.readNBytesCompat(com.airbridge.engine.Continuity.MAX_VCARD_LENGTH + 1)
            require(bytes.size <= com.airbridge.engine.Continuity.MAX_VCARD_LENGTH) { "Too many contacts to share at once" }
            String(bytes, Charsets.UTF_8)
        }
    }

    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (out.size() < limit) {
            val n = read(buf, 0, minOf(buf.size, limit - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }
}
