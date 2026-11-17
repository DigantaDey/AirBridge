package com.airbridge.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BatteryChargeEstimateTest {
    @Test
    fun onlyReportsAnAvailableEstimateWhileCharging() {
        assertEquals(90L * 60 * 1_000, BatteryChargeEstimate.sanitize(90L * 60 * 1_000, charging = true))
        assertNull(BatteryChargeEstimate.sanitize(-1, charging = true))
        assertNull(BatteryChargeEstimate.sanitize(0, charging = true))
        assertNull(BatteryChargeEstimate.sanitize(90L * 60 * 1_000, charging = false))
        assertNull(BatteryChargeEstimate.sanitize(BatteryChargeEstimate.MAX_ESTIMATE_MS + 1, charging = true))
    }
}
