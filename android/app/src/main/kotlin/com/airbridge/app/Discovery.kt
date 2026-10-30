package com.airbridge.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import java.net.Inet4Address

/**
 * mDNS browse for the desktop AirBridge server (`_airbridge._tcp`, registered
 * by mdnsService.ts). Found hosts surface as `ws://ip:port/ws` candidates the
 * user can tap to connect — no typing, no QR reader needed on the phone.
 */
class ServerDiscovery(
    context: Context,
    private val onFound: (url: String, serviceName: String) -> Unit,
    private val onLost: (serviceName: String) -> Unit,
) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    @Volatile private var started = false

    private val discoveryListener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(regType: String?) {
            started = true
        }
        override fun onServiceFound(info: NsdServiceInfo) {
            try {
                nsd.resolveService(info, resolveListener)
            } catch (_: Exception) {
            }
        }
        override fun onServiceLost(info: NsdServiceInfo) {
            onLost(info.serviceName)
        }
        override fun onDiscoveryStopped(regType: String?) {
            started = false
        }
        override fun onStartDiscoveryFailed(regType: String?, code: Int) {
            Log.w(TAG, "start discovery failed: $code")
        }
        override fun onStopDiscoveryFailed(regType: String?, code: Int) {
            Log.w(TAG, "stop discovery failed: $code")
        }
    }

    private val resolveListener = object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo?, code: Int) {
            Log.w(TAG, "resolve failed: $code")
        }
        override fun onServiceResolved(info: NsdServiceInfo) {
            val host = info.hostAddresses.firstOrNull { it is Inet4Address }
                ?: info.hostAddresses.firstOrNull()
                ?: return
            val url = "ws://${host.hostAddress}:${info.port}/ws"
            onFound(url, info.serviceName)
        }
    }

    fun start() {
        if (started) return
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Exception) {
            Log.w(TAG, "discover failed: ${e.message}")
        }
    }

    fun stop() {
        if (!started) return
        try {
            nsd.stopServiceDiscovery(discoveryListener)
        } catch (_: Exception) {
        }
        started = false
    }

    companion object {
        const val SERVICE_TYPE = "_airbridge._tcp."
        private const val TAG = "AirBridgeNsd"
    }
}
