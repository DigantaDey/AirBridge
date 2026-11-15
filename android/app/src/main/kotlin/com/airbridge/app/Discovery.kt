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
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private val queue = DiscoveryQueue<NsdServiceInfo>()
    private var resolveTimeoutRunnable: Runnable? = null
    @Volatile
    private var active = false

    private val discoveryListener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(regType: String?) {
            mainHandler.post {
                if (!active) return@post
                queue.start()
                processNextResolution()
            }
        }
        override fun onServiceFound(info: NsdServiceInfo) {
            mainHandler.post {
                if (!active) return@post
                queue.enqueue(info.serviceName, info)
                processNextResolution()
            }
        }
        override fun onServiceLost(info: NsdServiceInfo) {
            mainHandler.post {
                queue.removePending(info.serviceName)
                onLost(info.serviceName)
            }
        }
        override fun onDiscoveryStopped(regType: String?) {
            mainHandler.post { clearResolveTimeout(); queue.reset() }
        }
        override fun onStartDiscoveryFailed(regType: String?, code: Int) {
            Log.w(TAG, "start discovery failed: $code")
            mainHandler.post { clearResolveTimeout(); queue.reset() }
        }
        override fun onStopDiscoveryFailed(regType: String?, code: Int) {
            Log.w(TAG, "stop discovery failed: $code")
        }
    }

    private fun clearResolveTimeout() {
        resolveTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        resolveTimeoutRunnable = null
    }

    private fun processNextResolution() {
        val (generation, name, nextService) = queue.nextToResolve() ?: return

        clearResolveTimeout()
        val timeoutRunnable = Runnable {
            if (!queue.finish(generation)) return@Runnable
            resolveTimeoutRunnable = null
            Log.w(TAG, "Resolve timeout (5s) for $name")
            processNextResolution()
        }
        resolveTimeoutRunnable = timeoutRunnable
        mainHandler.postDelayed(timeoutRunnable, RESOLVE_TIMEOUT_MS)

        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo?, code: Int) {
                mainHandler.post {
                    if (!queue.finish(generation)) return@post
                    mainHandler.removeCallbacks(timeoutRunnable)
                    if (resolveTimeoutRunnable === timeoutRunnable) resolveTimeoutRunnable = null
                    Log.w(TAG, "resolve failed for ${info?.serviceName ?: name}: $code")
                    processNextResolution()
                }
            }

            override fun onServiceResolved(info: NsdServiceInfo) {
                mainHandler.post {
                    if (!queue.finish(generation)) return@post
                    mainHandler.removeCallbacks(timeoutRunnable)
                    if (resolveTimeoutRunnable === timeoutRunnable) resolveTimeoutRunnable = null
                    val host = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        DiscoveryUrlFormatter.pickBestAddress(info.hostAddresses)
                    } else {
                        @Suppress("DEPRECATION")
                        info.host
                    }
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
            queue.finish(generation)
            processNextResolution()
        }
    }

    fun start() {
        if (active || queue.started) return
        active = true
        queue.start()
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Exception) {
            Log.w(TAG, "discover failed: ${e.message}")
            active = false
            queue.reset()
        }
    }

    fun stop() {
        if (!active && !queue.started) return
        active = false
        clearResolveTimeout()
        queue.reset()
        try {
            nsd.stopServiceDiscovery(discoveryListener)
        } catch (_: Exception) {
        }
    }

    companion object {
        const val SERVICE_TYPE = "_airbridge._tcp."
        private const val RESOLVE_TIMEOUT_MS = 5_000L
        private const val TAG = "AirBridgeNsd"
    }
}
