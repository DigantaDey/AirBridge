package com.airbridge.app

import android.Manifest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HotspotHandoffGuidanceTest {
    @Test
    fun bluetoothOffExplainsThatWiFiIsTheManualFallback() {
        val guidance = HotspotHandoffGuidance.phoneBluetoothOff()
        assertTrue(guidance.contains("on this phone"))
        assertTrue(guidance.contains("automatic handoff"))
        assertTrue(guidance.contains("Show Wi-Fi details"))
    }

    @Test
    fun manualInstructionsDistinguishSsidFromBluetoothAndRecoverTheLink() {
        val guidance = HotspotHandoffGuidance.manualConnectionSteps()
        assertTrue(guidance.contains("Wi-Fi network name (SSID)"))
        assertTrue(guidance.contains("not a Bluetooth name"))
        assertTrue(guidance.contains("Reconnect now"))
        assertTrue(guidance.contains("current QR code"))
        assertTrue(guidance.contains("new address"))
    }

    @Test
    fun bluetoothDiscoveryDoesNotRequireMatchingOrPairingDeviceNames() {
        val guidance = HotspotHandoffGuidance.computerNotFound()
        assertTrue(guidance.contains("compatible Mac"))
        assertTrue(guidance.contains("private service"))
        assertTrue(guidance.contains("phone's Bluetooth name is irrelevant", ignoreCase = true))
        assertTrue(guidance.contains("no Bluetooth pairing", ignoreCase = true))
    }

    @Test
    fun bluetoothPermissionIsOptionalForStartingAHotspot() {
        assertArrayEquals(
            arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES),
            HotspotHandoff.requiredHotspotPermissionsFor(34),
        )
        assertArrayEquals(
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT),
            HotspotHandoff.requiredBluetoothPermissionsFor(34),
        )
        assertFalse(HotspotHandoff.requiredHotspotPermissionsFor(34).any { it.startsWith("android.permission.BLUETOOTH") })
        assertTrue(HotspotHandoff.requiredPermissionsFor(34).contains(Manifest.permission.BLUETOOTH_SCAN))
        assertArrayEquals(
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
            HotspotHandoff.requiredHotspotPermissionsFor(32),
        )
    }
}
