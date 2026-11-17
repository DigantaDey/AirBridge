package com.airbridge.app.ui.viewmodels

import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.PowerManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.airbridge.app.ClipboardAccessibilityService
import com.airbridge.app.ClipboardImageProvider
import com.airbridge.app.ClipboardText
import com.airbridge.app.ConnectionService
import com.airbridge.app.NativeEngineUiState
import com.airbridge.app.NativeFiles
import com.airbridge.app.Prefs
import com.airbridge.app.ServerDiscovery
import com.airbridge.engine.ClipboardItem
import com.airbridge.engine.PairingLink
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class NearbyHost(val name: String, val address: String)

data class AirBridgeAppUiState(
    val isPaired: Boolean = false,
    val configuredTarget: String = "",
    val preferredAddressInput: String = "",
    val deviceName: String = "",
    val visibility: String = "nearby",
    val themeMode: String = "dark",
    val autoClipboard: Boolean = true,
    val receiveClipboard: Boolean = true,
    val notificationSharing: Boolean = true,
    val connectionContinuity: Boolean = true,
    val accessibilityOptIn: Boolean = false,
    val accessibilityEnabled: Boolean = false,
    val batteryExempt: Boolean = false,
    val hasCamera: Boolean = true,
    val nearbyHosts: List<NearbyHost> = emptyList(),
    val stagedFiles: List<NativeFiles.PickedUriMeta> = emptyList(),
    val selectedPeerId: String? = null,
    val engine: NativeEngineUiState = NativeEngineUiState(),
    val scannerOpen: Boolean = false,
    val pairingSheetOpen: Boolean = false,
    val connectError: String? = null,
    val isSending: Boolean = false,
    val isConnecting: Boolean = false,
)

private data class LocalPrefsSnapshot(
    val isPaired: Boolean,
    val configuredTarget: String,
    val preferredAddressInput: String,
    val deviceName: String,
    val visibility: String,
    val themeMode: String,
    val autoClipboard: Boolean,
    val receiveClipboard: Boolean,
    val notificationSharing: Boolean,
    val connectionContinuity: Boolean,
    val accessibilityOptIn: Boolean,
    val accessibilityEnabled: Boolean,
    val batteryExempt: Boolean,
)

private data class UiOverlaysSnapshot(
    val scannerOpen: Boolean,
    val pairingSheetOpen: Boolean,
    val connectError: String?,
    val isSending: Boolean,
    val isConnecting: Boolean,
    val selectedPeerId: String?,
)

class AirBridgeViewModel(application: Application) : AndroidViewModel(application) {
    private val appContext: Context = application.applicationContext
    private val prefs = Prefs(appContext)
    private val nearbyLock = Any()
    private val nearbyMap = LinkedHashMap<String, NearbyHost>()
    private var discovery: ServerDiscovery? = null

    private val _local = MutableStateFlow(readLocalSnapshot())
    private val _nearbyHosts = MutableStateFlow<List<NearbyHost>>(emptyList())
    private val _stagedFiles = MutableStateFlow<List<NativeFiles.PickedUriMeta>>(emptyList())
    private val _overlays = MutableStateFlow(
        UiOverlaysSnapshot(
            scannerOpen = false,
            pairingSheetOpen = false,
            connectError = null,
            isSending = false,
            isConnecting = false,
            selectedPeerId = null,
        ),
    )

    private val _events = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val events: SharedFlow<String> = _events.asSharedFlow()

    val hasCamera: Boolean = appContext.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    val uiState: StateFlow<AirBridgeAppUiState> = combine(
        _local,
        _nearbyHosts,
        _stagedFiles,
        _overlays,
        ConnectionService.uiState,
    ) { local, nearby, staged, overlay, engine ->
        val resolvedPeerId = when {
            overlay.selectedPeerId != null && engine.peers.any { it.peerId == overlay.selectedPeerId } ->
                overlay.selectedPeerId
            else -> engine.peers.firstOrNull { it.discoveryScope == "paired" }?.peerId
                ?: engine.peers.firstOrNull()?.peerId
        }
        AirBridgeAppUiState(
            isPaired = local.isPaired,
            configuredTarget = local.configuredTarget,
            preferredAddressInput = local.preferredAddressInput,
            deviceName = if (engine.ready && engine.deviceName.isNotEmpty()) engine.deviceName else local.deviceName,
            visibility = if (engine.ready) engine.visibility else local.visibility,
            themeMode = local.themeMode,
            autoClipboard = if (engine.ready) engine.autoClipboard else local.autoClipboard,
            receiveClipboard = if (engine.ready) engine.receiveClipboard else local.receiveClipboard,
            notificationSharing = local.notificationSharing,
            connectionContinuity = local.connectionContinuity,
            accessibilityOptIn = local.accessibilityOptIn,
            accessibilityEnabled = local.accessibilityEnabled,
            batteryExempt = local.batteryExempt,
            hasCamera = hasCamera,
            nearbyHosts = nearby,
            stagedFiles = staged,
            selectedPeerId = resolvedPeerId,
            engine = engine,
            scannerOpen = overlay.scannerOpen,
            pairingSheetOpen = overlay.pairingSheetOpen,
            // Input validation first, else the engine's classified failure
            // (TCP timeout vs TLS vs pair code) so the connect screen shows
            // the same layer-specific guidance as the status card.
            connectError = overlay.connectError ?: engine.connectionHelp
                ?.takeIf { engine.connectionState != com.airbridge.engine.ConnectionState.CONNECTED }
                ?.userMessage,
            isSending = overlay.isSending,
            isConnecting = overlay.isConnecting && !engine.ready,
        )
    }.stateIn(
        viewModelScope,
        SharingStarted.WhileSubscribed(5_000),
        AirBridgeAppUiState(
            isPaired = prefs.target.isNotEmpty(),
            configuredTarget = prefs.target,
            preferredAddressInput = prefs.target,
            deviceName = prefs.deviceName,
            visibility = prefs.visibility,
            themeMode = prefs.themeMode,
            hasCamera = hasCamera,
        ),
    )

    init {
        refreshSystemStatus()
        if (prefs.target.isEmpty()) startDiscovery()
    }

    private fun readLocalSnapshot(): LocalPrefsSnapshot {
        val power = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager
        val target = prefs.target
        return LocalPrefsSnapshot(
            isPaired = target.isNotEmpty(),
            configuredTarget = target,
            preferredAddressInput = target,
            deviceName = prefs.deviceName,
            visibility = prefs.visibility,
            themeMode = prefs.themeMode,
            autoClipboard = prefs.autoClipboard,
            receiveClipboard = prefs.receiveClipboard,
            notificationSharing = prefs.notificationSharing,
            connectionContinuity = prefs.connectionContinuity,
            accessibilityOptIn = prefs.accessibilityClipboardOptIn,
            accessibilityEnabled = runCatching { ClipboardAccessibilityService.isEnabled(appContext) }.getOrDefault(false),
            batteryExempt = runCatching { power.isIgnoringBatteryOptimizations(appContext.packageName) }.getOrDefault(false),
        )
    }

    fun refreshSystemStatus() {
        _local.value = readLocalSnapshot()
    }

    fun startDiscovery() {
        if (discovery != null) return
        val found = ServerDiscovery(
            appContext,
            onFound = { url, name ->
                val link = PairingLink.parse(url) ?: return@ServerDiscovery
                val address = link.copy(scheme = "https").baseUrl
                synchronized(nearbyLock) {
                    nearbyMap[address] = NearbyHost(name = name, address = address)
                    _nearbyHosts.value = nearbyMap.values.toList()
                }
            },
            onLost = { name ->
                synchronized(nearbyLock) {
                    nearbyMap.entries.removeAll { it.value.name == name }
                    _nearbyHosts.value = nearbyMap.values.toList()
                }
            },
        )
        discovery = found
        found.start()
    }

    fun refreshDiscovery() {
        discovery?.stop()
        discovery = null
        synchronized(nearbyLock) {
            nearbyMap.clear()
            _nearbyHosts.value = emptyList()
        }
        startDiscovery()
    }

    private fun stopDiscovery() {
        discovery?.stop()
        discovery = null
    }

    fun clearConnectError() {
        if (_overlays.value.connectError != null) {
            _overlays.value = _overlays.value.copy(connectError = null)
        }
    }

    fun startHotspotHandoff() {
        ConnectionService.currentHost()?.startHotspotHandoff()
            ?: notifyMessage("Not ready yet. Try again in a moment.")
    }

    fun stopHotspotHandoff() {
        ConnectionService.currentHost()?.stopHotspotHandoff()
    }

    fun reconnect() {
        val host = ConnectionService.currentHost()
        if (host != null) {
            host.reconnect()
        } else {
            startConnectionService(ConnectionService.ACTION_START)
        }
    }

    fun connectToAddress(rawAddress: String) {
        val trimmed = rawAddress.trim()
        if (trimmed.isEmpty()) {
            _overlays.value = _overlays.value.copy(connectError = "Enter your computer's address or URL")
            return
        }
        val link = PairingLink.parse(trimmed)
        if (link == null) {
            _overlays.value = _overlays.value.copy(connectError = "Enter a valid address, e.g. 192.168.1.5:3000")
            return
        }
        connectWithLink(link)
    }

    fun connectWithLink(link: PairingLink) {
        stopDiscovery()
        // Replaces the whole previous invitation: target, staged code (cleared
        // for a manual address so an old unconsumed QR invite cannot be
        // replayed), QR alternates + TLS pin, endpoints learned on an older
        // network. Bumps the invitation generation so ConnectionService
        // restarts the engine even when the computer's address is unchanged.
        prefs.stageInvitation(link)
        _overlays.value = _overlays.value.copy(
            scannerOpen = false,
            pairingSheetOpen = false,
            connectError = null,
            isConnecting = true,
        )
        _local.value = readLocalSnapshot()
        startConnectionService(ConnectionService.ACTION_START)
    }

    fun handleScannedQr(payload: String): Boolean {
        val trimmed = payload.trim()
        if (trimmed.contains("/api/beam/")) {
            _events.tryEmit("That is a one-off file link, not a pairing code")
            return false
        }
        var link = PairingLink.parse(trimmed)
        if (link == null) {
            _events.tryEmit("That QR code is not an AirBridge pairing code")
            return false
        }

        if (link.host.isEmpty() || link.host.equals("localhost", ignoreCase = true) || link.host == "127.0.0.1") {
            val nearby = synchronized(nearbyLock) { _nearbyHosts.value.firstOrNull() }
            if (nearby != null) {
                val nearbyLink = PairingLink.parse(nearby.address)
                if (nearbyLink != null) {
                    link = nearbyLink.copy(pairCode = link.pairCode ?: nearbyLink.pairCode)
                }
            } else if (prefs.target.isNotEmpty() && link.pairCode != null) {
                // Joined live on the current connection: an older staged code
                // is now obsolete and must not be claimed by a later restart.
                prefs.consumePendingPairCode()
                joinPairCode(link.pairCode!!)
                _overlays.value = _overlays.value.copy(scannerOpen = false)
                return true
            }
        }

        if (link.host.isEmpty()) {
            _events.tryEmit("Scanned code needs a server address or active discovery")
            return false
        }

        connectWithLink(link)
        return true
    }

    fun forgetComputer() {
        runCatching { appContext.stopService(Intent(appContext, ConnectionService::class.java)) }
        prefs.forget()
        _stagedFiles.value = emptyList()
        _overlays.value = UiOverlaysSnapshot(
            scannerOpen = false,
            pairingSheetOpen = false,
            connectError = null,
            isSending = false,
            isConnecting = false,
            selectedPeerId = null,
        )
        _local.value = readLocalSnapshot()
        startDiscovery()
        _events.tryEmit("Disconnected from computer")
    }

    fun openScanner() {
        _overlays.value = _overlays.value.copy(scannerOpen = true)
    }

    fun closeScanner() {
        _overlays.value = _overlays.value.copy(scannerOpen = false)
    }

    fun setPairingSheetOpen(open: Boolean) {
        _overlays.value = _overlays.value.copy(pairingSheetOpen = open)
    }

    fun selectPeer(peerId: String) {
        _overlays.value = _overlays.value.copy(selectedPeerId = peerId)
    }

    fun stagePickedUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        viewModelScope.launch {
            val inspected = withContext(Dispatchers.IO) {
                uris.mapNotNull { uri ->
                    runCatching { NativeFiles.inspectUri(appContext, uri) }.getOrNull()
                }
            }
            if (inspected.isEmpty()) {
                _events.tryEmit("Could not read selected files")
                return@launch
            }
            val current = _stagedFiles.value.associateBy { it.uri }.toMutableMap()
            for (item in inspected) {
                if (current.size >= 100) break
                current[item.uri] = item
            }
            _stagedFiles.value = current.values.toList()
        }
    }

    fun removeStagedFile(uri: Uri) {
        _stagedFiles.value = _stagedFiles.value.filterNot { it.uri == uri }
    }

    fun clearStagedFiles() {
        _stagedFiles.value = emptyList()
    }

    fun sendStagedFiles() {
        val peerId = uiState.value.selectedPeerId
        val files = _stagedFiles.value
        if (peerId == null) {
            _events.tryEmit("Select an online computer first")
            return
        }
        if (files.isEmpty()) {
            _events.tryEmit("Choose one or more files first")
            return
        }
        _overlays.value = _overlays.value.copy(isSending = true)
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                val host = ConnectionService.currentHost()
                    ?: return@withContext Result.failure<Any>(IllegalStateException("Transfer service is reconnecting; try again"))
                host.sendFiles(peerId, files.map { it.uri })
            }
            _overlays.value = _overlays.value.copy(isSending = false)
            result.onSuccess {
                _stagedFiles.value = emptyList()
                _events.tryEmit("Sending ${files.size} file${if (files.size == 1) "" else "s"}…")
            }.onFailure { err ->
                _events.tryEmit(err.message ?: "Could not start transfer")
            }
        }
    }

    fun acceptTransfer(transferId: String) {
        ConnectionService.currentHost()?.acceptTransfer(transferId)
    }

    fun declineTransfer(transferId: String) {
        ConnectionService.currentHost()?.declineTransfer(transferId)
    }

    fun cancelTransfer(transferId: String) {
        ConnectionService.currentHost()?.cancelTransfer(transferId)
    }

    fun beamText(text: String, onSent: () -> Unit = {}) {
        val peerId = uiState.value.selectedPeerId
        if (peerId == null) {
            _events.tryEmit("Connect to a computer first")
            return
        }
        if (text.isBlank()) return
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                val host = ConnectionService.currentHost()
                    ?: return@withContext Result.failure<ClipboardItem>(IllegalStateException("Service is connecting"))
                host.sendClipboardText(peerId, text)
            }
            result.onSuccess {
                onSent()
                _events.tryEmit("Clipboard beamed")
            }.onFailure { err ->
                _events.tryEmit(err.message ?: "Failed to send clipboard")
            }
        }
    }

    fun beamImageUri(uri: Uri) {
        val peerId = uiState.value.selectedPeerId
        if (peerId == null) {
            _events.tryEmit("Connect to a computer first")
            return
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                val host = ConnectionService.currentHost()
                    ?: return@withContext Result.failure<ClipboardItem>(IllegalStateException("Service is connecting"))
                host.sendClipboardImageUri(peerId, uri)
            }
            result.onSuccess {
                _events.tryEmit("Image beamed")
            }.onFailure { err ->
                _events.tryEmit(err.message ?: "Failed to beam image")
            }
        }
    }

    fun beamSystemClipboardNow() {
        val text = ClipboardText.read(appContext)
        if (text.isNullOrBlank()) {
            _events.tryEmit("System clipboard has no plain text right now")
            return
        }
        beamText(text)
    }

    fun copyClipboardItem(item: ClipboardItem) {
        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                val image = item.imageDataUrl
                if (image != null) {
                    ClipboardImageProvider.copyImage(appContext, image)
                } else {
                    ConnectionService.markOwnClipboardWrite(item.text)
                    val manager = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    manager.setPrimaryClip(ClipData.newPlainText("AirBridge", item.text))
                }
            }.onSuccess {
                _events.tryEmit("Copied to clipboard")
            }.onFailure {
                _events.tryEmit("Could not copy to clipboard")
            }
        }
    }

    fun clearClipboardHistory() {
        ConnectionService.currentHost()?.clearClipboardHistory()
    }

    fun joinPairCode(rawCode: String, onJoined: () -> Unit = {}) {
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                val host = ConnectionService.currentHost()
                    ?: return@withContext Result.failure<Unit>(IllegalStateException("Service is connecting"))
                host.joinPairCode(rawCode)
            }
            result.onSuccess {
                onJoined()
                _overlays.value = _overlays.value.copy(pairingSheetOpen = false)
                _events.tryEmit("Paired with code")
            }.onFailure { err ->
                _events.tryEmit(err.message ?: "Invalid pair code")
            }
        }
    }

    fun rotatePairCode() {
        ConnectionService.currentHost()?.rotatePairCode()
        _events.tryEmit("Pair code rotated")
    }

    fun setTrusted(peerPublicKey: String, trusted: Boolean) {
        ConnectionService.currentHost()?.setTrusted(peerPublicKey, trusted)
    }

    fun renameDevice(name: String) {
        val clean = name.trim().take(80)
        if (clean.isEmpty()) return
        prefs.deviceName = clean
        ConnectionService.currentHost()?.renameDevice(clean)
        _local.value = readLocalSnapshot()
        _events.tryEmit("Device renamed to $clean")
    }

    fun setVisibility(mode: String) {
        val normalized = Prefs.normalizeVisibility(mode)
        prefs.visibility = normalized
        ConnectionService.currentHost()?.setVisibility(normalized)
        _local.value = readLocalSnapshot()
    }

    fun setThemeMode(mode: String) {
        val normalized = when (mode) {
            "light", "dark", "system" -> mode
            else -> "dark"
        }
        prefs.themeMode = normalized
        _local.value = readLocalSnapshot()
    }

    fun setAutoClipboard(enabled: Boolean) {
        prefs.autoClipboard = enabled
        ConnectionService.currentHost()?.setAutoClipboard(enabled)
        _local.value = readLocalSnapshot()
    }

    fun setReceiveClipboard(enabled: Boolean) {
        prefs.receiveClipboard = enabled
        ConnectionService.currentHost()?.setReceiveClipboard(enabled)
        _local.value = readLocalSnapshot()
    }

    fun setNotificationSharing(enabled: Boolean) {
        prefs.notificationSharing = enabled
        _local.value = readLocalSnapshot()
    }

    fun setConnectionContinuity(enabled: Boolean) {
        prefs.connectionContinuity = enabled
        if (enabled && prefs.target.isNotEmpty()) {
            startConnectionService(ConnectionService.ACTION_START)
        }
        _local.value = readLocalSnapshot()
    }

    fun setAccessibilityOptIn(enabled: Boolean) {
        prefs.accessibilityClipboardOptIn = enabled
        _local.value = readLocalSnapshot()
    }

    fun startConnectionService(action: String = ConnectionService.ACTION_START) {
        if (prefs.target.isEmpty()) return
        if (action == ConnectionService.ACTION_UI_DETACH && ConnectionService.currentHost() == null) return
        val intent = Intent(appContext, ConnectionService::class.java)
            .setPackage(appContext.packageName)
            .setAction(action)
        runCatching {
            if (action != ConnectionService.ACTION_UI_DETACH) {
                appContext.startForegroundService(intent)
            } else {
                appContext.startService(intent)
            }
        }
    }

    fun notifyMessage(message: String) {
        _events.tryEmit(message)
    }

    override fun onCleared() {
        stopDiscovery()
        super.onCleared()
    }
}
