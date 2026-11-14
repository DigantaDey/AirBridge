package com.airbridge.engine

import java.io.IOException
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit

/** A bounded pipeline: both bytes and item count matter (including empty frames). */
internal class ByteBoundedQueue<T>(
    private val maxBytes: Int,
    private val maxItems: Int = 128,
    private val timeoutMs: Long = 0,
    private val sizeOf: (T) -> Int,
) {
    init { require(maxBytes > 0 && maxItems > 0 && timeoutMs >= 0) }
    private val lock = java.lang.Object()
    private val items = ArrayDeque<T>()
    private var bytes = 0L
    private var closed = false

    val isEmpty: Boolean get() = synchronized(lock) { items.isEmpty() }

    fun put(item: T) = synchronized(lock) {
        val size = sizeOf(item)
        require(size >= 0)
        val deadline = if (timeoutMs > 0) System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs) else Long.MAX_VALUE
        // A valid large clipboard envelope may exceed the file-pipeline budget.
        // Admit it alone, never alongside another message.
        while (!closed && (items.size >= maxItems || (items.isNotEmpty() && bytes + size > maxBytes))) {
            if (timeoutMs == 0L) lock.wait()
            else {
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) throw IOException("Network pipeline stalled")
                lock.wait(maxOf(1, TimeUnit.NANOSECONDS.toMillis(remaining)))
            }
        }
        if (closed) throw IOException("Engine stopped")
        items.addLast(item)
        bytes += size
        lock.notifyAll()
    }

    fun take(): T? = synchronized(lock) {
        while (!closed && items.isEmpty()) lock.wait()
        val item = items.pollFirst() ?: return null
        bytes -= sizeOf(item)
        lock.notifyAll()
        item
    }

    fun clear() = synchronized(lock) { items.clear(); bytes = 0; lock.notifyAll() }
    fun close() = synchronized(lock) { closed = true; items.clear(); bytes = 0; lock.notifyAll() }
}
