package com.airbridge.app

/** Android's charge-time API can return -1 when no trustworthy estimate is available. */
internal object BatteryChargeEstimate {
    const val MAX_ESTIMATE_MS = 7L * 24 * 60 * 60 * 1_000

    fun sanitize(estimateMs: Long?, charging: Boolean): Long? =
        estimateMs?.takeIf { charging && it > 0L && it <= MAX_ESTIMATE_MS }
}
