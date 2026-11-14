package com.airbridge.engine

/** Byte-bounded network queue. A slow socket must never retain an entire file. */
internal class OutboundQueue(maxBytes: Int = 4 * 1024 * 1024) {
    private val queue = ByteBoundedQueue<Outbound>(maxBytes, timeoutMs = 60_000) { it.payload.size }
    val isEmpty: Boolean get() = queue.isEmpty
    fun put(item: Outbound) = queue.put(item)
    fun take(): Outbound? = queue.take()
    fun clear() = queue.clear()
    fun close() = queue.close()
}
