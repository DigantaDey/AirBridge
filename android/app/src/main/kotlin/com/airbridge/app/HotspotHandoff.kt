package com.airbridge.app

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.wifi.SoftApConfiguration
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import com.airbridge.engine.Handoff
import java.util.UUID

/** What the hotspot handoff card shows. */
data class HandoffUiState(
    /** Handoff keys from a code-authenticated pairing are saved: the feature can be offered. */
    val available: Boolean = false,
    val phase: Phase = Phase.IDLE,
    val message: String? = null,
    /** Hotspot name while it runs (never the password). */
    val ssid: String? = null,
) {
    enum class Phase { IDLE, STARTING, OFFERING, WAITING, JOINED, FAILED }

    val active: Boolean
        get() = phase == Phase.STARTING || phase == Phase.OFFERING || phase == Phase.WAITING || phase == Phase.JOINED
}

/**
 * "Use this phone's hotspot": starts an Android local-only hotspot and hands
 * its credentials to the paired computer, which joins it by itself.
 *
 * Credentials are sealed to the computer's handoff key (vouched for by the
 * code-holding computer at pairing time, see [Handoff.seal]) and travel either
 * over the live session (Wi-Fi or relay) or, with no session at all, over
 * Bluetooth LE to the computer's GATT service. Only a computer whose rotating
 * tag proves it holds the paired beacon secret is written to, so an impostor
 * advertising the same service gets nothing (and could not open it anyway).
 *
 * Threading: all state lives on the main looper (hotspot and GATT callbacks
 * are posted there); [onChange] is invoked there too.
 */
class HotspotHandoff(
    private val context: Context,
    private val info: () -> Handoff.Info?,
    private val pairCode: () -> String,
    private val reversePort: () -> Int?,
    private val identityKey: () -> String,
    private val deviceName: () -> String,
    /** Sends over the live session; false when there is none. */
    private val sendOverSession: (ByteArray) -> Boolean,
    private val sendEnd: (String) -> Boolean,
    private val onChange: () -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val bluetooth = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    @Volatile var state: HandoffUiState = HandoffUiState(available = info() != null)
        private set

    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    private var envelope: ByteArray? = null
    /** Id the computer assigned (session path); used to end the handoff cleanly. */
    @Volatile private var sessionHandoffId: String? = null
    private var ble: BleOffer? = null
    private var sessionFallback: Runnable? = null

    fun refreshAvailability() {
        main.post {
            val available = info() != null
            if (available != state.available) update(state.copy(available = available))
        }
    }

    /** Runtime permissions this feature needs on the running Android version. */
    fun requiredPermissions(): Array<String> = requiredPermissionsFor(Build.VERSION.SDK_INT)

    fun missingPermissions(): List<String> = requiredPermissions().filter {
        context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
    }

    fun start() {
        main.post { startOnMain() }
    }

    /** Stops the hotspot and tells the computer. Synchronous on the main thread (e.g. service teardown). */
    fun stop() {
        if (Looper.myLooper() == main.looper) stopOnMain(userInitiated = true)
        else main.post { stopOnMain(userInitiated = true) }
    }

    /** Host teardown from any thread: tell the computer now (the engine stops next), then release the hotspot. */
    fun shutdown() {
        sessionHandoffId?.let { id -> runCatching { sendEnd(id) } }
        sessionHandoffId = null
        stop()
    }

    /** Status from the computer over the session. */
    fun onSessionStatus(id: String, s: Handoff.State, reason: String) {
        main.post { sessionStatus(id, s, reason) }
    }

    /** The session (re)connected while an offer is outstanding: resend it there. */
    fun onSessionUp() {
        main.post {
            val env = envelope ?: return@post
            if (state.phase != HandoffUiState.Phase.OFFERING || ble != null || sessionHandoffId != null) return@post
            sendOverSession(env)
        }
    }

    private fun sessionStatus(id: String, s: Handoff.State, reason: String) {
        if (envelope == null) return
        sessionHandoffId = id
        sessionFallback?.let { main.removeCallbacks(it) }
        sessionFallback = null
        // The session path works; a parallel Bluetooth attempt is redundant.
        ble?.close()
        ble = null
        applyStatus(s, reason)
    }

    @SuppressLint("MissingPermission")
    private fun startOnMain() {
        if (state.active) return
        val keys = info()
        if (keys == null) {
            fail("Pair with the computer using its code or QR first; then it can join this phone's hotspot.")
            return
        }
        if (missingPermissions().isNotEmpty()) {
            fail("Allow Nearby devices (Wi-Fi and Bluetooth) so AirBridge can start a hotspot for the computer.")
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && !locationEnabled()) {
            fail("Turn on Location: this Android version requires it to start a hotspot.")
            return
        }
        update(HandoffUiState(available = true, phase = HandoffUiState.Phase.STARTING, message = "Starting a hotspot…"))
        try {
            wifi.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
                override fun onStarted(res: WifiManager.LocalOnlyHotspotReservation) {
                    if (state.phase != HandoffUiState.Phase.STARTING) {
                        res.close() // stopped while starting
                        return
                    }
                    reservation = res
                    onHotspotStarted(keys, res)
                }

                override fun onStopped() {
                    if (reservation != null) stopOnMain(userInitiated = false, message = "The hotspot stopped.")
                }

                override fun onFailed(reason: Int) {
                    fail(
                        when (reason) {
                            ERROR_TETHERING_DISALLOWED -> "This phone's policy doesn't allow hotspots."
                            ERROR_INCOMPATIBLE_MODE -> "Turn off the regular hotspot (or Wi-Fi Direct) and try again."
                            ERROR_NO_CHANNEL -> "No free Wi-Fi channel for a hotspot right now. Try again in a moment."
                            else -> "Android couldn't start a hotspot (code $reason)."
                        },
                    )
                }
            }, main)
        } catch (e: SecurityException) {
            fail("Android blocked the hotspot: ${e.message ?: "permission missing"}.")
        } catch (e: IllegalStateException) {
            fail("Another app is already using a hotspot. Stop it and try again.")
        }
    }

    private fun onHotspotStarted(keys: Handoff.Info, res: WifiManager.LocalOnlyHotspotReservation) {
        val creds = credentials(res)
        if (creds == null) {
            stopOnMain(userInitiated = false)
            fail("Android didn't report a password-protected hotspot, so it can't be shared safely.")
            return
        }
        val env = try {
            Handoff.seal(
                keys.key,
                pairCode(),
                Handoff.Offer(
                    ssid = creds.ssid,
                    psk = creds.psk,
                    security = creds.security,
                    reversePort = reversePort() ?: DEFAULT_REVERSE_PORT,
                    identityKey = identityKey(),
                    deviceName = deviceName(),
                ),
            )
        } catch (e: Exception) {
            stopOnMain(userInitiated = false)
            fail("This hotspot can't be shared: ${e.message}")
            return
        }
        envelope = env
        update(state.copy(phase = HandoffUiState.Phase.OFFERING, ssid = creds.ssid, message = "Offering “${creds.ssid}” to the computer…"))
        if (sendOverSession(env)) {
            // Starting a hotspot drops this phone's own Wi-Fi (and the session
            // with it) on phones without concurrent AP+STA. No reply soon means
            // the offer didn't make it: try Bluetooth.
            val fallback = Runnable { if (envelope === env && sessionHandoffId == null) startBle(keys, env) }
            sessionFallback = fallback
            main.postDelayed(fallback, SESSION_REPLY_MS)
        } else {
            startBle(keys, env)
        }
    }

    private fun startBle(keys: Handoff.Info, env: ByteArray) {
        sessionFallback = null
        val adapter = bluetooth?.adapter
        if (adapter == null || !adapter.isEnabled) {
            update(
                state.copy(
                    phase = HandoffUiState.Phase.WAITING,
                    message = "Not connected to the computer and Bluetooth is off. Turn on Bluetooth, or join “${state.ssid}” on the computer by hand.",
                ),
            )
            return
        }
        update(state.copy(phase = HandoffUiState.Phase.OFFERING, message = "Looking for the computer over Bluetooth…"))
        ble?.close()
        ble = BleOffer(keys, env).also { it.start() }
    }

    private fun applyStatus(s: Handoff.State, reason: String) {
        val ssid = state.ssid ?: "the hotspot"
        when (s) {
            Handoff.State.PENDING -> update(state.copy(phase = HandoffUiState.Phase.WAITING, message = "Waiting for approval on the computer…"))
            Handoff.State.JOINING -> update(state.copy(phase = HandoffUiState.Phase.WAITING, message = "The computer is joining “$ssid”…"))
            Handoff.State.JOINED -> update(state.copy(phase = HandoffUiState.Phase.JOINED, message = "The computer is on this phone's hotspot. Transfers go direct."))
            Handoff.State.DECLINED -> finish("The computer declined the hotspot.")
            Handoff.State.EXPIRED -> finish("Nobody answered on the computer in time.")
            Handoff.State.FAILED -> finish(reason.ifBlank { "The computer couldn't join the hotspot." })
            Handoff.State.INVALID -> finish(reason.ifBlank { "The computer rejected the offer. Pair again with its code." })
            Handoff.State.ENDED -> finish("The computer left the hotspot.")
        }
    }

    private fun finish(message: String) {
        sessionHandoffId = null // already over on the computer; nothing to end
        stopOnMain(userInitiated = false)
        update(HandoffUiState(available = info() != null, phase = HandoffUiState.Phase.FAILED, message = message))
    }

    private fun fail(message: String) {
        Log.w(TAG, message)
        update(HandoffUiState(available = info() != null, phase = HandoffUiState.Phase.FAILED, message = message))
    }

    private fun stopOnMain(userInitiated: Boolean, message: String? = null) {
        sessionFallback?.let { main.removeCallbacks(it) }
        sessionFallback = null
        ble?.close()
        ble = null
        sessionHandoffId?.let { id -> runCatching { sendEnd(id) } }
        sessionHandoffId = null
        envelope = null
        val res = reservation
        reservation = null
        runCatching { res?.close() }
        if (userInitiated || message != null) {
            update(
                HandoffUiState(
                    available = info() != null,
                    phase = if (message != null) HandoffUiState.Phase.FAILED else HandoffUiState.Phase.IDLE,
                    message = message,
                ),
            )
        }
    }

    private fun update(next: HandoffUiState) {
        state = next
        onChange()
    }

    private fun locationEnabled(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return true
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return true
        return lm.isLocationEnabled
    }

    private data class Credentials(val ssid: String, val psk: String, val security: Handoff.Security)

    @Suppress("DEPRECATION")
    private fun credentials(res: WifiManager.LocalOnlyHotspotReservation): Credentials? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val config = res.softApConfiguration
            val ssid = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                config.wifiSsid?.toString()?.removeSurrounding("\"")
            } else {
                config.ssid
            }
            val psk = config.passphrase
            val security = when (config.securityType) {
                SoftApConfiguration.SECURITY_TYPE_WPA2_PSK -> Handoff.Security.WPA2
                SoftApConfiguration.SECURITY_TYPE_WPA3_SAE_TRANSITION -> Handoff.Security.WPA2_WPA3
                SoftApConfiguration.SECURITY_TYPE_WPA3_SAE -> Handoff.Security.WPA3
                else -> return null // open (or unknown): never offered
            }
            if (ssid.isNullOrEmpty() || psk.isNullOrEmpty()) return null
            return Credentials(ssid, psk, security)
        }
        val config = res.wifiConfiguration ?: return null
        val ssid = config.SSID?.removeSurrounding("\"")
        val psk = config.preSharedKey?.removeSurrounding("\"")
        if (ssid.isNullOrEmpty() || psk.isNullOrEmpty()) return null
        return Credentials(ssid, psk, Handoff.Security.WPA2)
    }

    /**
     * Scan → connect → read the tag (must prove the paired beacon secret) →
     * write the sealed offer → follow the status characteristic.
     */
    @SuppressLint("MissingPermission")
    private inner class BleOffer(private val keys: Handoff.Info, private val env: ByteArray) {
        private val tried = HashSet<String>()
        private var gatt: BluetoothGatt? = null
        private var scanning = false
        private var closed = false
        private var lastStatus: Handoff.State? = null

        private val poll = object : Runnable {
            override fun run() {
                val g = gatt ?: return
                if (closed) return
                statusChar(g)?.let { g.readCharacteristic(it) }
                main.postDelayed(this, STATUS_POLL_MS)
            }
        }

        private val findTimeout = Runnable {
            if (!closed && lastStatus == null) {
                close()
                if (ble === this) ble = null
                update(
                    state.copy(
                        phase = HandoffUiState.Phase.WAITING,
                        message = "No paired AirBridge computer found over Bluetooth. Keep AirBridge running on the computer, or join “${state.ssid}” there by hand.",
                    ),
                )
            }
        }

        private val scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val device = result.device ?: return
                main.post {
                    if (closed || gatt != null || !tried.add(device.address)) return@post
                    connect(device)
                }
            }

            override fun onScanFailed(errorCode: Int) {
                main.post {
                    if (closed) return@post
                    scanning = false
                    update(state.copy(phase = HandoffUiState.Phase.WAITING, message = "Bluetooth scan failed (code $errorCode). Join “${state.ssid}” on the computer by hand."))
                }
            }
        }

        private val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                main.post {
                    if (closed || g !== gatt) return@post
                    when (newState) {
                        BluetoothProfile.STATE_CONNECTED -> if (!g.requestMtu(MTU)) g.discoverServices()
                        BluetoothProfile.STATE_DISCONNECTED -> next()
                    }
                }
            }

            override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                main.post { if (!closed && g === gatt) g.discoverServices() }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                main.post {
                    if (closed || g !== gatt) return@post
                    val tag = g.getService(SERVICE)?.getCharacteristic(TAG_CHAR)
                    if (status != BluetoothGatt.GATT_SUCCESS || tag == null || !g.readCharacteristic(tag)) next()
                }
            }

            // API < 33 delivers reads/notifications here; 33+ uses the value overloads below.
            @Deprecated("Deprecated in Android 13")
            @Suppress("DEPRECATION")
            override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
                onValue(g, c.uuid, c.value ?: ByteArray(0), status)
            }

            override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
                onValue(g, c.uuid, value, status)
            }

            @Deprecated("Deprecated in Android 13")
            @Suppress("DEPRECATION")
            override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
                onValue(g, c.uuid, c.value ?: ByteArray(0), BluetoothGatt.GATT_SUCCESS)
            }

            override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
                onValue(g, c.uuid, value, BluetoothGatt.GATT_SUCCESS)
            }

            override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
                main.post { onWritten(g, c.uuid, status) }
            }
        }

        fun start() {
            main.postDelayed(findTimeout, BLE_FIND_MS)
            scan()
        }

        fun close() {
            if (closed) return
            closed = true
            main.removeCallbacks(poll)
            main.removeCallbacks(findTimeout)
            stopScan()
            gatt?.let { runCatching { it.disconnect(); it.close() } }
            gatt = null
        }

        private fun scan() {
            if (scanning || closed) return
            val scanner = bluetooth?.adapter?.bluetoothLeScanner ?: return
            val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
            runCatching { scanner.startScan(listOf(filter), settings, scanCallback) }
                .onSuccess { scanning = true }
                .onFailure { Log.w(TAG, "BLE scan failed to start", it) }
        }

        private fun stopScan() {
            if (!scanning) return
            scanning = false
            runCatching { bluetooth?.adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
        }

        private fun connect(device: BluetoothDevice) {
            stopScan()
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        }

        /** Not our computer (or it went away): drop it and keep scanning. */
        private fun next() {
            main.removeCallbacks(poll)
            gatt?.let { runCatching { it.disconnect(); it.close() } }
            gatt = null
            scan()
        }

        private fun statusChar(g: BluetoothGatt): BluetoothGattCharacteristic? =
            g.getService(SERVICE)?.getCharacteristic(STATUS)

        private fun onValue(g: BluetoothGatt, uuid: UUID, value: ByteArray, status: Int) {
            val copy = value.copyOf()
            main.post { handleValue(g, uuid, copy, status) }
        }

        private fun handleValue(g: BluetoothGatt, uuid: UUID, value: ByteArray, status: Int) {
            if (closed || g !== gatt) return
            when (uuid) {
                TAG_CHAR -> {
                    if (status != BluetoothGatt.GATT_SUCCESS || !Handoff.matchesTag(keys.beacon, value, System.currentTimeMillis())) {
                        // Another AirBridge computer, or an impostor: send it nothing.
                        next()
                        return
                    }
                    main.removeCallbacks(findTimeout)
                    write(g)
                }
                STATUS -> {
                    val (s, reason) = Handoff.parseBleStatus(value) ?: return
                    if (s == lastStatus) return
                    lastStatus = s
                    applyStatus(s, reason)
                    if (s == Handoff.State.JOINED || s.terminal) {
                        // Done with Bluetooth: the session takes over on the hotspot.
                        close()
                        if (ble === this) ble = null
                    }
                }
            }
        }

        private fun onWritten(g: BluetoothGatt, uuid: UUID, status: Int) {
            if (closed || g !== gatt || uuid != OFFER) return
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Offer write failed (GATT status $status)")
                next()
                return
            }
            update(state.copy(phase = HandoffUiState.Phase.WAITING, message = "Sent over Bluetooth. Waiting for approval on the computer…"))
            subscribe(g)
            main.postDelayed(poll, STATUS_POLL_MS)
        }

        @Suppress("DEPRECATION")
        private fun write(g: BluetoothGatt) {
            val c = g.getService(SERVICE)?.getCharacteristic(OFFER) ?: return next()
            val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(c, env, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS
            } else {
                c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                c.value = env
                g.writeCharacteristic(c)
            }
            if (!ok) next()
        }

        @Suppress("DEPRECATION")
        private fun subscribe(g: BluetoothGatt) {
            val c = statusChar(g) ?: return
            if (!g.setCharacteristicNotification(c, true)) return
            val cccd = c.getDescriptor(CCCD) ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            } else {
                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                g.writeDescriptor(cccd)
            }
        }
    }

    companion object {
        private const val TAG = "AirBridgeHandoff"
        /** The engine's reverse listener port when it isn't running (the computer dials it after joining). */
        private const val DEFAULT_REVERSE_PORT = 47390
        private const val SESSION_REPLY_MS = 6_000L
        private const val BLE_FIND_MS = 30_000L
        private const val STATUS_POLL_MS = 2_000L
        private const val MTU = 517
        private val SERVICE: UUID = UUID.fromString(Handoff.SERVICE_UUID)
        private val TAG_CHAR: UUID = UUID.fromString(Handoff.TAG_UUID)
        private val OFFER: UUID = UUID.fromString(Handoff.OFFER_UUID)
        private val STATUS: UUID = UUID.fromString(Handoff.STATUS_UUID)
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        /** Pure so it can be unit tested per API level. */
        fun requiredPermissionsFor(sdk: Int): Array<String> = buildList {
            if (sdk >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.NEARBY_WIFI_DEVICES)
            else {
                // Android 12-12L lets the user grant only approximate location; both must be asked.
                add(Manifest.permission.ACCESS_FINE_LOCATION)
                add(Manifest.permission.ACCESS_COARSE_LOCATION)
            }
            if (sdk >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_SCAN)
                add(Manifest.permission.BLUETOOTH_CONNECT)
            }
        }.toTypedArray()
    }
}
