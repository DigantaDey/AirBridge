package com.airbridge.engine

import java.net.Inet4Address
import java.net.InetAddress
import java.util.ArrayDeque

/**
 * Sequential mDNS resolution state machine with deduplication and generation
 * tokens. Android's NsdManager allows only one `resolveService` call at a
 * time; using explicit generation tokens guarantees a slow callback arriving
 * after a timeout cannot clear `inFlightName` or launch overlapping resolves.
 */
class DiscoveryQueue<T> {
    private data class QueuedItem<T>(val name: String, val item: T)

    private val pending = ArrayDeque<QueuedItem<T>>()
    var activeGeneration: Long = 0L
        private set
    var inFlightName: String? = null
        private set
    var started: Boolean = false
        private set

    fun start() {
        started = true
    }

    /** Adds [item] if not already queued or actively resolving. Returns true if queued. */
    fun enqueue(name: String, item: T): Boolean {
        if (!started) return false
        if (name == inFlightName) return false
        if (pending.any { it.name == name }) return false
        pending.addLast(QueuedItem(name, item))
        return true
    }

    /** Removes a lost service from the pending queue. */
    fun removePending(name: String) {
        val it = pending.iterator()
        while (it.hasNext()) {
            if (it.next().name == name) it.remove()
        }
    }

    /**
     * Pops the next item to resolve if idle and started, advancing
     * [activeGeneration]. Returns `(generation, name, item)` or null.
     */
    fun nextToResolve(): Triple<Long, String, T>? {
        if (!started || inFlightName != null || pending.isEmpty()) return null
        val next = pending.removeFirst()
        inFlightName = next.name
        val gen = ++activeGeneration
        return Triple(gen, next.name, next.item)
    }

    /**
     * Completes or times out an active resolution ONLY if [generation] still
     * matches [activeGeneration]. Returns true if this completion was current.
     */
    fun finish(generation: Long): Boolean {
        if (generation != activeGeneration || inFlightName == null) return false
        inFlightName = null
        return true
    }

    fun pendingCount(): Int = pending.size

    fun reset() {
        started = false
        pending.clear()
        inFlightName = null
        activeGeneration++
    }
}

/** Selects the best local address (preferring non-loopback IPv4) and formats a ws:// URL. */
object DiscoveryUrlFormatter {
    fun pickBestAddress(addresses: List<InetAddress>): InetAddress? =
        addresses.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
            ?: addresses.firstOrNull { it is Inet4Address }
            ?: addresses.firstOrNull { !it.isLinkLocalAddress && !it.isLoopbackAddress }
            ?: addresses.firstOrNull()

    fun formatWsUrl(address: InetAddress, port: Int): String? {
        if (port <= 0 || port > 65535) return null
        val raw = address.hostAddress?.substringBefore('%')?.trim().orEmpty()
        if (raw.isEmpty()) return null
        return if (raw.contains(':')) "ws://[$raw]:$port/ws" else "ws://$raw:$port/ws"
    }
}
