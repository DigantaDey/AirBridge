package com.airbridge.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.airbridge.engine.DiscoveryQueue
import com.airbridge.engine.DiscoveryUrlFormatter
import java.util.concurrent.Executor

/**
 * mDNS browse for the desktop AirBridge server (`_airbridge._tcp`, registered
 * by mdnsService.ts). Found hosts surface as `ws://ip:port/ws` candidates, which
 * the unpaired connect screen lists as "Computers on this network" — so a phone
 * on the same Wi-Fi can connect without typing an address or scanning a QR.
 */
class ServerDiscovery(
    context: Context,
    private val onFound: (url: String, serviceName: String) -> Unit,
    private val onLost: (serviceName: String) -> Unit,
) {
    private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { command -> mainHandler.post(command) }
    private val queue = DiscoveryQueue<NsdServiceInfo>()
    private var resolveTimeoutRunnable: Runnable? = null
    private var activeCancelResolution: (() -> Unit)? = null
    @Volatile private var active = false
    @Volatile private var activeListener: NsdManager.DiscoveryListener? = null

    private fun newDiscoveryListener(): NsdManager.DiscoveryListener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(regType: String?) {
            val self = this
            mainHandler.post {
                if (!active || activeListener !== self) return@post
                AndroidDiagnostics.nsdActive = true
                queue.start()
                processNextResolution()
            }
        }
        override fun onServiceFound(info: NsdServiceInfo) {
            val self = this
            mainHandler.post {
                if (!active || activeListener !== self) return@post
                queue.enqueue(info.serviceName, info)
                processNextResolution()
            }
        }
        override fun onServiceLost(info: NsdServiceInfo) {
            val self = this
            mainHandler.post {
                if (activeListener !== self) return@post
                queue.removePending(info.serviceName)
                onLost(info.serviceName)
            }
        }
        override fun onDiscoveryStopped(regType: String?) {
            val self = this
            mainHandler.post {
                if (activeListener === self) {
                    AndroidDiagnostics.nsdActive = false
                    clearActiveResolution()
                    queue.reset()
                }
            }
        }
        override fun onStartDiscoveryFailed(regType: String?, code: Int) {
            val self = this
            Log.w(TAG, "start discovery failed: $code")
            AndroidDiagnostics.nsdLastErrorCode = code
            AndroidDiagnostics.recordEvent("nsd", "start discovery failed: $code", "WARN")
            mainHandler.post {
                if (activeListener === self) {
                    active = false
                    activeListener = null
                    AndroidDiagnostics.nsdActive = false
                    clearActiveResolution()
                    queue.reset()
                }
            }
        }
        override fun onStopDiscoveryFailed(regType: String?, code: Int) {
            Log.w(TAG, "stop discovery failed: $code")
            AndroidDiagnostics.nsdLastErrorCode = code
        }
    }

    private fun clearActiveResolution() {
        resolveTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        resolveTimeoutRunnable = null
        val cancel = activeCancelResolution
        activeCancelResolution = null
        runCatching { cancel?.invoke() }
    }

    private fun processNextResolution() {
        val (generation, name, nextService) = queue.nextToResolve() ?: return

        clearActiveResolution()
        val timeoutRunnable = Runnable {
            if (!queue.finish(generation)) return@Runnable
            resolveTimeoutRunnable = null
            val cancel = activeCancelResolution
            activeCancelResolution = null
            runCatching { cancel?.invoke() }
            Log.w(TAG, "Resolve timeout (5s) for $name")
            AndroidDiagnostics.recordNsdResolveTimeout()
            AndroidDiagnostics.recordEvent("nsd", "Resolve timeout (5s) for $name", "WARN")
            processNextResolution()
        }
        resolveTimeoutRunnable = timeoutRunnable
        mainHandler.postDelayed(timeoutRunnable, RESOLVE_TIMEOUT_MS)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            var unregistered = false
            lateinit var callback: NsdManager.ServiceInfoCallback
            fun unregisterOnce() {
                if (unregistered) return
                unregistered = true
                runCatching { nsd.unregisterServiceInfoCallback(callback) }
            }
            callback = object : NsdManager.ServiceInfoCallback {
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
                    mainHandler.post {
                        if (!queue.finish(generation)) return@post
                        unregistered = true
                        mainHandler.removeCallbacks(timeoutRunnable)
                        if (resolveTimeoutRunnable === timeoutRunnable) resolveTimeoutRunnable = null
                        activeCancelResolution = null
                        AndroidDiagnostics.nsdLastErrorCode = errorCode
                        Log.w(TAG, "serviceInfoCallback registration failed for $name: $errorCode")
                        processNextResolution()
                    }
                }

                override fun onServiceUpdated(info: NsdServiceInfo) {
                    mainHandler.post {
                        if (!queue.finish(generation)) {
                            unregisterOnce()
                            return@post
                        }
                        unregisterOnce()
                        mainHandler.removeCallbacks(timeoutRunnable)
                        if (resolveTimeoutRunnable === timeoutRunnable) resolveTimeoutRunnable = null
                        activeCancelResolution = null
                        val host = DiscoveryUrlFormatter.pickBestAddress(info.hostAddresses)
                        val url = host?.let { DiscoveryUrlFormatter.formatWsUrl(it, info.port) }
                        if (url != null) {
                            onFound(url, info.serviceName)
                        }
                        processNextResolution()
                    }
                }

                override fun onServiceLost() {
                    mainHandler.post {
                        if (queue.finish(generation)) {
                            unregisterOnce()
                            mainHandler.removeCallbacks(timeoutRunnable)
                            if (resolveTimeoutRunnable === timeoutRunnable) resolveTimeoutRunnable = null
                            activeCancelResolution = null
                            processNextResolution()
                        }
                    }
                }

                override fun onServiceInfoCallbackUnregistered() {
                    unregistered = true
                }
            }
            activeCancelResolution = { unregisterOnce() }
            try {
                nsd.registerServiceInfoCallback(nextService, mainExecutor, callback)
            } catch (e: Exception) {
                Log.w(TAG, "registerServiceInfoCallback failed: ${e.message}")
                mainHandler.removeCallbacks(timeoutRunnable)
                if (resolveTimeoutRunnable === timeoutRunnable) resolveTimeoutRunnable = null
                activeCancelResolution = null
                queue.finish(generation)
                processNextResolution()
            }
        } else {
            val listener = object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo?, code: Int) {
                    mainHandler.post {
                        if (!queue.finish(generation)) return@post
                        mainHandler.removeCallbacks(timeoutRunnable)
                        if (resolveTimeoutRunnable === timeoutRunnable) resolveTimeoutRunnable = null
                        activeCancelResolution = null
                        AndroidDiagnostics.nsdLastErrorCode = code
                        Log.w(TAG, "resolve failed for ${info?.serviceName ?: name}: $code")
                        processNextResolution()
                    }
                }

                override fun onServiceResolved(info: NsdServiceInfo) {
                    mainHandler.post {
                        if (!queue.finish(generation)) return@post
                        mainHandler.removeCallbacks(timeoutRunnable)
                        if (resolveTimeoutRunnable === timeoutRunnable) resolveTimeoutRunnable = null
                        activeCancelResolution = null
                        @Suppress("DEPRECATION")
                        val host = info.host
                        val url = host?.let { DiscoveryUrlFormatter.formatWsUrl(it, info.port) }
                        if (url != null) {
                            onFound(url, info.serviceName)
                        }
                        processNextResolution()
                    }
                }
            }

            try {
                @Suppress("DEPRECATION")
                nsd.resolveService(nextService, listener)
            } catch (e: Exception) {
                Log.w(TAG, "resolveService failed: ${e.message}")
                mainHandler.removeCallbacks(timeoutRunnable)
                if (resolveTimeoutRunnable === timeoutRunnable) resolveTimeoutRunnable = null
                activeCancelResolution = null
                queue.finish(generation)
                processNextResolution()
            }
        }
    }

    @Synchronized
    fun start() {
        if (active || queue.started) return
        active = true
        AndroidDiagnostics.nsdActive = true
        queue.start()
        val freshListener = newDiscoveryListener()
        activeListener = freshListener
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, freshListener)
        } catch (e: Exception) {
            Log.w(TAG, "discover failed: ${e.message}")
            active = false
            activeListener = null
            AndroidDiagnostics.nsdActive = false
            queue.reset()
        }
    }

    @Synchronized
    fun stop() {
        val listenerToStop = activeListener
        if (!active && !queue.started && listenerToStop == null) return
        active = false
        activeListener = null
        AndroidDiagnostics.nsdActive = false
        clearActiveResolution()
        queue.reset()
        if (listenerToStop != null) {
            try {
                nsd.stopServiceDiscovery(listenerToStop)
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        const val SERVICE_TYPE = "_airbridge._tcp."
        private const val RESOLVE_TIMEOUT_MS = 5_000L
        private const val TAG = "AirBridgeNsd"
    }
}

/**
 * Advertises this phone's reverse-connection listener (`_airbridge-rv._tcp`,
 * see com.airbridge.engine.ReverseListener) so a computer on the same Wi-Fi
 * whose firewall blocks inbound connections can dial the phone instead. On the
 * phone's own hotspot the computer needs no mDNS: it dials its default gateway.
 * The instance name is a neutral id, not the user's device name.
 */
class ReverseAdvertiser(context: Context) {
    private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    @Volatile private var listener: NsdManager.RegistrationListener? = null

    fun start(port: Int, deviceId: String, addresses: List<String>) {
        if (listener != null) return
        val info = NsdServiceInfo().apply {
            serviceName = "AirBridge-" + deviceId.take(6).ifEmpty { "phone" }
            serviceType = com.airbridge.engine.ReverseListener.SERVICE_TYPE
            setPort(port)
            setAttribute("v", "1")
            if (addresses.isNotEmpty()) setAttribute("a", addresses.take(4).joinToString(","))
        }
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
                Log.i(TAG, "reverse service registered: ${serviceInfo.serviceName}:$port")
            }
            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "reverse service registration failed: $errorCode")
                listener = null
            }
            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {}
            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
        }
        listener = l
        runCatching { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l) }
            .onFailure { Log.w(TAG, "reverse service unavailable: ${it.message}"); listener = null }
    }

    fun stop() {
        val l = listener ?: return
        listener = null
        runCatching { nsd.unregisterService(l) }
    }

    private companion object { const val TAG = "AirBridgeReverse" }
}
