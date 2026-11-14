package com.airbridge.engine

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/**
 * A single-value mailbox for replaceable state (snapshots/system clipboard),
 * never for file chunks or commands. A slow consumer retains at most its
 * current value plus the newest pending one, not an unbounded executor queue.
 * Resubmitting at the queue's tail also lets unrelated commands run fairly.
 */
class LatestTask<T : Any>(private val executor: Executor, private val consume: (T) -> Unit) {
    private val lock = Any()
    private var pending: T? = null
    private var scheduled = false

    fun offer(value: T) {
        val submit = synchronized(lock) {
            pending = value
            if (scheduled) false else { scheduled = true; true }
        }
        if (submit) schedule()
    }

    private fun schedule() {
        try {
            executor.execute {
                val value = synchronized(lock) { pending.also { pending = null } }
                try { if (value != null) consume(value) }
                finally {
                    val again = synchronized(lock) {
                        if (pending == null) { scheduled = false; false } else true
                    }
                    if (again) schedule()
                }
            }
        } catch (_: RejectedExecutionException) {
            synchronized(lock) { pending = null; scheduled = false }
        }
    }
}
