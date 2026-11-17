@file:Suppress("DEPRECATION") // PhoneStateListener / TelecomManager call control: see CallMonitor.

package com.airbridge.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import android.util.Log
import com.airbridge.engine.AirCrypto
import com.airbridge.engine.CallCommand
import com.airbridge.engine.CallCommandResult
import com.airbridge.engine.CallController
import com.airbridge.engine.CallInfo
import com.airbridge.engine.ContactCard
import com.airbridge.engine.ContactEmail
import com.airbridge.engine.ContactPhone
import com.airbridge.engine.ContactProvider
import com.airbridge.engine.ContactShareItem
import com.airbridge.engine.Continuity
import com.airbridge.engine.ContinuityChannel
import com.airbridge.engine.ContinuityException
import com.airbridge.engine.ScreenShareRequest
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.roundToInt

/** Runtime permissions behind each phone continuity feature. */
object ContinuityPermissions {
    val CONTACTS = arrayOf(Manifest.permission.READ_CONTACTS)

    /**
     * READ_PHONE_STATE: ringing/off-hook/idle. ANSWER_PHONE_CALLS: answer,
     * reject and hang up. CALL_PHONE: place calls. AirBridge intentionally
     * does not request the restricted READ_CALL_LOG permission: caller history
     * and caller numbers are not needed for remote call controls.
     */
    val CALLS: Array<String> = arrayOf(
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.ANSWER_PHONE_CALLS,
        Manifest.permission.CALL_PHONE,
    )

    private fun granted(context: Context, permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    fun contactsGranted(context: Context) = granted(context, Manifest.permission.READ_CONTACTS)

    fun callsGranted(context: Context) = CALLS.all { granted(context, it) }

    fun hasTelephony(context: Context) = context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)

    fun screenCaptureSupported(context: Context) = context.getSystemService(MediaProjectionManager::class.java) != null
}

/** Reads the address book through ContactsContract (READ_CONTACTS). */
class AndroidContactProvider(private val context: Context) : ContactProvider {
    override fun query(query: String, limit: Int): List<ContactCard> {
        if (!ContinuityPermissions.contactsGranted(context)) {
            throw ContinuityException("permission", "Allow AirBridge to read contacts on the phone.")
        }
        data class Builder(val id: Long, var name: String, val starred: Boolean) {
            val phones = ArrayList<ContactPhone>()
            val emails = ArrayList<ContactEmail>()
            var organization: String? = null
            var note: String? = null
        }
        val byId = LinkedHashMap<Long, Builder>()
        val projection = arrayOf(
            ContactsContract.Data.CONTACT_ID,
            ContactsContract.Data.MIMETYPE,
            ContactsContract.Data.DISPLAY_NAME_PRIMARY,
            ContactsContract.Data.STARRED,
            ContactsContract.Data.DATA1,
            ContactsContract.Data.DATA2,
            ContactsContract.Data.DATA3,
        )
        val mimes = arrayOf(
            ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
            ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
            ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE,
            ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE,
        )
        val selection = "${ContactsContract.Data.MIMETYPE} IN (?, ?, ?, ?)"
        val cursor = context.contentResolver.query(
            ContactsContract.Data.CONTENT_URI, projection, selection, mimes,
            "${ContactsContract.Data.DISPLAY_NAME_PRIMARY} COLLATE LOCALIZED ASC",
        ) ?: throw ContinuityException("failed", "The contacts database is unavailable.")
        cursor.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                val name = c.getString(2)?.trim().orEmpty()
                val b = byId.getOrPut(id) { Builder(id, name, c.getInt(3) == 1) }
                val data = c.getString(4)?.trim().orEmpty()
                if (data.isEmpty()) continue
                when (c.getString(1)) {
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE ->
                        if (b.phones.size < Continuity.MAX_CONTACT_VALUES && b.phones.none { it.number == data }) {
                            b.phones.add(ContactPhone(data, phoneLabel(c.getInt(5), c.getString(6))))
                        }
                    ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE ->
                        if (b.emails.size < Continuity.MAX_CONTACT_VALUES && b.emails.none { it.address.equals(data, true) }) {
                            b.emails.add(ContactEmail(data, emailLabel(c.getInt(5), c.getString(6))))
                        }
                    ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE -> if (b.organization == null) b.organization = data
                    ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE -> if (b.note == null) b.note = data
                }
            }
        }
        return byId.values.asSequence()
            .map { ContactCard(it.name, it.phones, it.emails, it.organization, it.note, it.id.toString(), it.starred) }
            .filter { it.name.isNotEmpty() || it.phones.isNotEmpty() || it.emails.isNotEmpty() }
            .filter { Continuity.contactMatches(it, query) }
            .sortedWith(compareByDescending<ContactCard> { it.starred }.thenBy { it.name.lowercase() })
            .take(limit) // the channel asks for one extra to report "truncated"
            .toList()
    }

    /** Display name for an incoming number (null without READ_CONTACTS or no match). */
    fun lookupName(number: String): String? {
        if (number.isBlank() || !ContinuityPermissions.contactsGranted(context)) return null
        return runCatching {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
            context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull()
    }

    private fun phoneLabel(type: Int, custom: String?): String = when (type) {
        ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE, ContactsContract.CommonDataKinds.Phone.TYPE_WORK_MOBILE -> "mobile"
        ContactsContract.CommonDataKinds.Phone.TYPE_HOME -> "home"
        ContactsContract.CommonDataKinds.Phone.TYPE_WORK -> "work"
        ContactsContract.CommonDataKinds.Phone.TYPE_MAIN -> "main"
        ContactsContract.CommonDataKinds.Phone.TYPE_FAX_HOME, ContactsContract.CommonDataKinds.Phone.TYPE_FAX_WORK,
        ContactsContract.CommonDataKinds.Phone.TYPE_OTHER_FAX -> "fax"
        ContactsContract.CommonDataKinds.Phone.TYPE_PAGER, ContactsContract.CommonDataKinds.Phone.TYPE_WORK_PAGER -> "pager"
        ContactsContract.CommonDataKinds.Phone.TYPE_CUSTOM -> custom?.trim()?.takeIf { it.isNotEmpty() } ?: "other"
        else -> "other"
    }

    private fun emailLabel(type: Int, custom: String?): String? = when (type) {
        ContactsContract.CommonDataKinds.Email.TYPE_HOME -> "home"
        ContactsContract.CommonDataKinds.Email.TYPE_WORK -> "work"
        ContactsContract.CommonDataKinds.Email.TYPE_CUSTOM -> custom?.trim()?.takeIf { it.isNotEmpty() }
        else -> null
    }
}

/**
 * Observes the phone's call state and executes answer / reject / hang up /
 * dial from a paired computer.
 *
 * Android only lets the default dialer (InCallService) see per-call detail,
 * so this uses the public TelephonyManager state (ringing / off-hook / idle)
 * and TelecomManager controls — the same APIs headset and car-kit apps use.
 * Call audio stays on the phone (or its Bluetooth headset): Android does not
 * allow third-party apps to capture or route cellular call audio.
 */
class CallMonitor(
    private val context: Context,
    private val contacts: AndroidContactProvider,
    private val onChange: (CallInfo) -> Unit,
) : CallController {
    private val telephony = context.getSystemService(TelephonyManager::class.java)
    private val telecom = context.getSystemService(TelecomManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "airbridge-calls").apply { isDaemon = true } }
    private val lock = Any()
    private var listener: PhoneStateListener? = null
    private var lastState = TelephonyManager.CALL_STATE_IDLE
    private var current: CallInfo? = null
    private var pendingDial: Pair<CallInfo, Long>? = null

    /** The call in progress, if any (re-sent when a computer connects). */
    fun currentCall(): CallInfo? = synchronized(lock) { current }

    fun start() = main.post {
        if (listener != null || telephony == null) return@post
        val l = object : PhoneStateListener() {
            override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                worker.execute { handle(state, phoneNumber) }
            }
        }
        runCatching { telephony.listen(l, PhoneStateListener.LISTEN_CALL_STATE) }
            .onSuccess { listener = l }
            .onFailure { Log.w(TAG, "Call state unavailable: ${it.message}") }
    }

    fun stop() = main.post {
        val l = listener ?: return@post
        runCatching { telephony?.listen(l, PhoneStateListener.LISTEN_NONE) }
        listener = null
        worker.execute {
            val ended = synchronized(lock) {
                lastState = TelephonyManager.CALL_STATE_IDLE
                current?.let { endedCopy(it) }.also { current = null }
            }
            ended?.let(onChange)
        }
    }

    fun shutdown() {
        stop()
        worker.shutdown()
    }

    private fun endedCopy(c: CallInfo) = c.copy(state = "ended", actions = emptyList(), updatedAt = System.currentTimeMillis())

    private fun handle(state: Int, rawNumber: String?) {
        val number = Continuity.sanitizePhoneNumber(rawNumber?.takeIf { it.isNotBlank() })
        val now = System.currentTimeMillis()
        val publish: CallInfo? = synchronized(lock) {
            val prev = lastState
            lastState = state
            val cur = current
            when (state) {
                TelephonyManager.CALL_STATE_RINGING -> when {
                    // A device may expose a number for an active call on older
                    // Android releases. We do not request call-log access for it.
                    prev == state && cur != null && cur.number == null && number != null ->
                        cur.copy(number = number, name = contacts.lookupName(number), updatedAt = now)
                    prev == state -> null
                    else -> CallInfo(
                        callId = AirCrypto.randomHex16(), state = "ringing", direction = "incoming",
                        number = number, name = number?.let { contacts.lookupName(it) },
                        updatedAt = now, actions = listOf("answer", "reject"),
                    )
                }
                TelephonyManager.CALL_STATE_OFFHOOK -> when {
                    prev == state -> null
                    prev == TelephonyManager.CALL_STATE_RINGING && cur != null ->
                        cur.copy(state = "active", connectedAt = now, updatedAt = now, actions = hangupActions())
                    else -> {
                        val dial = pendingDial?.takeIf { now - it.second < 15_000 }?.first
                        pendingDial = null
                        // Off-hook covers dialling and talking: Android exposes no
                        // "remote answered" signal outside the default dialer.
                        (dial ?: CallInfo(callId = AirCrypto.randomHex16(), state = "active", direction = "outgoing", updatedAt = now))
                            .copy(state = "active", connectedAt = now, updatedAt = now, actions = hangupActions())
                    }
                }
                else -> {
                    pendingDial = null
                    cur?.takeIf { it.state != "ended" }?.let { endedCopy(it) }
                }
            }.also { next ->
                if (next != null) current = if (next.state == "ended") null else next
            }
        }
        publish?.let(onChange)
    }

    private fun hangupActions() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) listOf("hangup") else emptyList()

    override fun execute(command: CallCommand): CallCommandResult {
        val tm = telecom ?: return CallCommandResult(false, "This device cannot make phone calls.")
        if (!ContinuityPermissions.hasTelephony(context)) return CallCommandResult(false, "This device has no phone service.")
        return try {
            when (command.action) {
                "answer" -> {
                    val cur = currentCall()
                    if (cur == null || cur.callId != command.callId || cur.state != "ringing") {
                        return CallCommandResult(false, "That call is no longer ringing.")
                    }
                    tm.acceptRingingCall()
                    CallCommandResult(true, callId = cur.callId)
                }
                "reject", "hangup" -> {
                    val cur = currentCall()
                    val pending = synchronized(lock) { pendingDial?.first }
                    val target = cur ?: pending
                    if (target == null || target.callId != command.callId) return CallCommandResult(false, "That call has already ended.")
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                        return CallCommandResult(false, "Ending calls from the computer needs Android 9 or later. Use the phone.")
                    }
                    if (tm.endCall()) CallCommandResult(true, callId = target.callId)
                    else CallCommandResult(false, "The phone did not end the call.")
                }
                "dial" -> {
                    val number = command.number ?: return CallCommandResult(false, "Invalid phone number.")
                    if (currentCall() != null) return CallCommandResult(false, "Finish the current call on the phone first.")
                    val call = CallInfo(
                        callId = AirCrypto.randomHex16(), state = "dialing", direction = "outgoing",
                        number = number, name = contacts.lookupName(number),
                        updatedAt = System.currentTimeMillis(), actions = hangupActions(),
                    )
                    synchronized(lock) { pendingDial = call to System.currentTimeMillis() }
                    tm.placeCall(Uri.fromParts("tel", number, null), Bundle())
                    onChange(call)
                    CallCommandResult(true, callId = call.callId)
                }
                else -> CallCommandResult(false, "Unknown call action.")
            }
        } catch (e: SecurityException) {
            synchronized(lock) { pendingDial = null }
            CallCommandResult(false, "Allow phone access for AirBridge on the phone (Settings → Phone continuity).")
        }
    }

    private companion object {
        const val TAG = "AirBridgeCalls"
    }
}

/**
 * Wires the Android providers into the engine's [ContinuityChannel]: feature
 * readiness (toggle + permission), call-state publishing, notifications for
 * incoming contact cards and screen-share consent.
 */
class PhoneContinuity(private val context: Context, private val prefs: Prefs) {
    private data class BatteryReading(val level: Int, val charging: Boolean, val voltageMv: Int?)

    private val contacts = AndroidContactProvider(context)
    @Volatile private var channel: ContinuityChannel? = null
    private val calls = CallMonitor(context, contacts) { call -> channel?.publishCallState(call) }
    private var lastFeatures: List<String> = emptyList()
    @Volatile private var lastBattery: BatteryReading? = null
    private var batteryReceiverRegistered = false
    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val reading = readBattery(intent) ?: return
            val shouldPublish = synchronized(this@PhoneContinuity) {
                val previous = lastBattery
                val changed = previous == null || previous.level != reading.level || previous.charging != reading.charging ||
                    (previous.voltageMv != null && reading.voltageMv != null && abs(previous.voltageMv - reading.voltageMv) >= 50) ||
                    (previous.voltageMv == null) != (reading.voltageMv == null)
                if (changed) lastBattery = reading
                changed
            }
            if (shouldPublish) publishBattery(reading)
        }
    }

    init {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        lastBattery = readBattery(context.registerReceiver(null, filter))
        try {
            if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(batteryReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else @Suppress("DEPRECATION") context.registerReceiver(batteryReceiver, filter)
            batteryReceiverRegistered = true
        } catch (e: Exception) {
            Log.w("AirBridgeBattery", "Could not observe battery status: ${e.message}")
        }
    }

    fun attach(channel: ContinuityChannel) {
        this.channel = channel
        channel.contactProvider = contacts
        channel.callController = calls
        refresh(announce = false)
        lastBattery?.let(::publishBattery)
    }

    private fun readBattery(intent: Intent?): BatteryReading? {
        intent ?: return null
        val rawLevel = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (rawLevel < 0 || scale <= 0) return null
        val level = (rawLevel * 100f / scale).roundToInt().coerceIn(0, 100)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            (status == BatteryManager.BATTERY_STATUS_UNKNOWN && plugged)
        val voltage = intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1).takeIf { it in 2_500..6_000 }
        return BatteryReading(level, charging, voltage)
    }

    private fun publishBattery(reading: BatteryReading) {
        channel?.publishBatteryStatus(reading.level, reading.charging, reading.voltageMv)
    }

    /** Re-evaluate toggles/permissions (Settings change, app resume); re-announce if changed. */
    fun refresh(announce: Boolean = true) {
        val ch = channel ?: return
        ch.contactsReady = prefs.contactsOnComputer && ContinuityPermissions.contactsGranted(context)
        val callsOk = prefs.callsFromComputer && ContinuityPermissions.hasTelephony(context) && ContinuityPermissions.callsGranted(context)
        ch.callsReady = callsOk
        val screenSharingEnabled = prefs.screenSharing && ContinuityPermissions.screenCaptureSupported(context)
        ch.screenSourceAvailable = screenSharingEnabled
        if (callsOk) calls.start() else calls.stop()
        if (!screenSharingEnabled) {
            // A switch-off is a real revocation, not just a change to the next
            // feature advertisement: reject queued requests and terminate any
            // already running capture immediately.
            ch.pendingScreenRequests().forEach { request ->
                ch.declineScreenShare(request.sessionId, "Screen sharing was disabled on the phone")
                ContinuityNotifications.cancel(context, ContinuityNotifications.screenRequestId(request.sessionId))
            }
            ScreenShareService.activeSessionId?.let { sessionId ->
                ch.stopScreenShare(sessionId, "Screen sharing was disabled on the phone")
                ScreenShareService.stopSession(context, sessionId)
            }
        }
        val features = ch.features()
        val changed = synchronized(this) { (features != lastFeatures).also { lastFeatures = features } }
        if (announce && changed) ch.announce()
    }

    /** A computer (re)connected: bring it up to date on a call in progress. */
    fun onPeersChanged() {
        calls.currentCall()?.let { channel?.publishCallState(it.copy(updatedAt = System.currentTimeMillis())) }
        lastBattery?.let(::publishBattery)
    }

    fun onContactsReceived(item: ContactShareItem) = ContinuityNotifications.contactReceived(context, item)

    fun onScreenShareRequest(request: ScreenShareRequest) = ContinuityNotifications.screenRequest(context, request)

    fun onScreenShareEnded(sessionId: String) {
        ContinuityNotifications.cancel(context, ContinuityNotifications.screenRequestId(sessionId))
        ScreenShareService.stopSession(context, sessionId)
    }

    fun detach() {
        calls.shutdown()
        if (batteryReceiverRegistered) {
            runCatching { context.unregisterReceiver(batteryReceiver) }
            batteryReceiverRegistered = false
        }
        channel = null
    }
}

/** Notifications for contact cards and screen-share consent. */
object ContinuityNotifications {
    private const val CHANNEL_ID = "airbridge_continuity"

    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Computer requests", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Screen sharing requests and contact cards from your paired computer"
            },
        )
    }

    fun screenRequestId(sessionId: String) = sessionId.hashCode() or 0x20000000

    fun cancel(context: Context, id: Int) {
        runCatching { context.getSystemService(NotificationManager::class.java)?.cancel(id) }
    }

    fun contactReceived(context: Context, item: ContactShareItem) {
        ensureChannel(context)
        val first = item.contacts.firstOrNull() ?: return
        val title = if (item.contacts.size == 1) "Contact from ${item.peerName}" else "${item.contacts.size} contacts from ${item.peerName}"
        val text = if (item.contacts.size == 1) "${first.name} — tap to save" else item.contacts.take(3).joinToString { it.name } + " — tap to save"
        val open = Intent(context, ContactImportActivity::class.java)
            .setPackage(context.packageName)
            .putExtra(ContactImportActivity.EXTRA_VCARD, item.vcard)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(
            context, item.shareId.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_add)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_SOCIAL)
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java)?.notify(item.shareId.hashCode() or 0x10000000, n) }
    }

    fun screenRequest(context: Context, request: ScreenShareRequest) {
        ensureChannel(context)
        val review = PendingIntent.getActivity(
            context, screenRequestId(request.sessionId),
            Intent(context, ScreenShareConsentActivity::class.java)
                .setPackage(context.packageName)
                .putExtra(ScreenShareConsentActivity.EXTRA_SESSION_ID, request.sessionId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val decline = PendingIntent.getService(
            context, screenRequestId(request.sessionId) xor 1,
            Intent(context, ScreenShareService::class.java)
                .setPackage(context.packageName)
                .setAction(ScreenShareService.ACTION_DECLINE)
                .putExtra(ScreenShareService.EXTRA_SESSION_ID, request.sessionId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("${request.peerName} wants to view your screen")
            .setContentText("Tap to review. Nothing is shared until you allow it.")
            .setContentIntent(review)
            .addAction(Notification.Action.Builder(null, "Review", review).build())
            .addAction(Notification.Action.Builder(null, "Decline", decline).build())
            .setCategory(Notification.CATEGORY_CALL)
            .setTimeoutAfter(Continuity.SCREEN_CONSENT_TIMEOUT_MS)
            .setAutoCancel(true)
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java)?.notify(screenRequestId(request.sessionId), n) }
    }
}
