package com.airbridge.engine

import java.io.IOException
import java.util.ArrayDeque

/** Byte-bounded network queue. A slow socket must never retain an entire file. */
internal class OutboundQueue(private val maxBytes: Int = 4 * 1024 * 1024) {
    private val lock = java.lang.Object()
    private val items = ArrayDeque<Outbound>()
    private var bytes = 0
    private var closed = false

    val isEmpty: Boolean get() = synchronized(lock) { items.isEmpty() }

    fun put(item: Outbound) = synchronized(lock) {
        val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(15)
        // A single clipboard envelope can exceed the file-pipeline budget.
        // Admit it alone, never alongside another oversized message.
        while (!closed && items.isNotEmpty() && bytes.toLong() + item.payload.size > maxBytes) {
            val remaining = deadline - System.nanoTime()
            if (remaining <= 0) throw IOException("Network write stalled")
            lock.wait(maxOf(1, java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(remaining)))
        }
        if (closed) throw IOException("Engine stopped")
        items.addLast(item)
        bytes += item.payload.size
        lock.notifyAll()
    }

    fun take(): Outbound? = synchronized(lock) {
        while (!closed && items.isEmpty()) lock.wait()
        val item = items.pollFirst() ?: return null
        bytes -= item.payload.size
        lock.notifyAll()
        item
    }

    fun clear() = synchronized(lock) {
        items.clear()
        bytes = 0
        lock.notifyAll()
    }

    fun close() = synchronized(lock) {
        closed = true
        items.clear()
        bytes = 0
        lock.notifyAll()
    }
}
