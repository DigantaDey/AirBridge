package com.airbridge.app

/** User-facing recovery copy for the optional BLE handoff and manual Wi-Fi fallback. */
internal object HotspotHandoffGuidance {
    fun phoneBluetoothOff(): String =
        "Bluetooth is off on this phone. Turn it on for automatic handoff, or use Show Wi-Fi details below to connect the computer manually."

    fun bluetoothPermissionMissing(): String =
        "Bluetooth permission wasn't granted. That's okay: automatic handoff is optional. Use Show Wi-Fi details below to connect the computer over Wi-Fi."

    fun bluetoothUnavailable(): String =
        "Bluetooth handoff isn't available right now. Use Show Wi-Fi details below to connect the computer over Wi-Fi."

    fun scanFailed(code: Int? = null): String =
        "AirBridge couldn't scan for its private Bluetooth service${code?.let { " (error $it)" } ?: ""}. No Bluetooth pairing or device-name matching is needed; use Show Wi-Fi details below instead."

    fun computerNotFound(): String =
        "No AirBridge computer was found over Bluetooth. Keep AirBridge open on a compatible Mac with Bluetooth on, or use Show Wi-Fi details below to join this phone's hotspot manually. The phone's Bluetooth name is irrelevant: AirBridge discovers its private service, so no manual Bluetooth pairing or device-name matching is needed."

    fun manualConnectionSteps(): String =
        "This is the temporary Wi-Fi network name (SSID), not a Bluetooth name. On the computer, open Wi-Fi settings and join it using the password above. Then tap Reconnect now on this phone or scan the computer's current QR code; the hotspot may give the computer a new address."
}
