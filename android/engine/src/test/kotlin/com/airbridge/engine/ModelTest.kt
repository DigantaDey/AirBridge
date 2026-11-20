package com.airbridge.engine

import kotlin.system.exitProcess

private var modelPassed = 0
private var modelFailed = 0

private fun mCheck(label: String, ok: Boolean, detail: () -> String = { "" }) {
    if (ok) modelPassed++ else {
        modelFailed++
        System.err.println("FAIL $label ${detail()}")
    }
}

fun runModelChecks() {
    modelPassed = 0
    modelFailed = 0
    // 1. ISO C0, C1, and DEL controls stripped; whitespace collapsed.
    val ctrl = DeviceProfile.fromJson(
        JsonValue.Obj()
            .put("name", "Mac\u0000\u0007\u001b[31m\u007f\u0085\u009fPro")
            .put("publicKey", "pk"),
    )
    mCheck("DeviceProfile strips ISO C0/C1/DEL controls", ctrl.name == "Mac[31mPro") { "got '${ctrl.name}'" }

    // 2. Whitespace normalization (newlines, tabs, runs).
    val ws = DeviceProfile.fromJson(
        JsonValue.Obj()
            .put("name", "  My\n\t  Mac \r  Pro  ")
            .put("publicKey", "pk"),
    )
    mCheck("DeviceProfile collapses whitespace", ws.name == "My Mac Pro") { "got '${ws.name}'" }

    // 3. Length cap at 80 chars without trailing space.
    val longName = "A".repeat(79) + "  " + "B".repeat(20)
    val capped = DeviceProfile.fromJson(
        JsonValue.Obj().put("name", longName).put("publicKey", "pk"),
    )
    mCheck("DeviceProfile caps at <= 80 chars and trims end", capped.name.length == 79 && capped.name == "A".repeat(79)) {
        "got '${capped.name}' (${capped.name.length})"
    }

    // 4. Empty / missing / control-only fallback to "Peer".
    val missing = DeviceProfile.fromJson(JsonValue.Obj().put("publicKey", "pk"))
    val blank = DeviceProfile.fromJson(JsonValue.Obj().put("name", " \t\n ").put("publicKey", "pk"))
    val ctrlOnly = DeviceProfile.fromJson(JsonValue.Obj().put("name", "\u0000\u0007\u007f\u0085").put("publicKey", "pk"))
    mCheck("DeviceProfile missing name -> Peer", missing.name == "Peer") { "got '${missing.name}'" }
    mCheck("DeviceProfile blank name -> Peer", blank.name == "Peer") { "got '${blank.name}'" }
    mCheck("DeviceProfile control-only name -> Peer", ctrlOnly.name == "Peer") { "got '${ctrlOnly.name}'" }

    // 5. Valid Unicode preserved.
    val unicode = DeviceProfile.fromJson(
        JsonValue.Obj().put("name", "Diganta’s MacBook 💻").put("publicKey", "pk"),
    )
    mCheck("DeviceProfile preserves Unicode", unicode.name == "Diganta’s MacBook 💻") { "got '${unicode.name}'" }

    // 6. AirBridgeEngine local device name uses shared sanitizer with "AirBridge Device" fallback.
    val eng = AirBridgeEngine(EngineConfig("ws://127.0.0.1:9/ws", "\u0000\u0007 \t\n "))
    try {
        mCheck("Engine local fallback is AirBridge Device", eng.deviceProfileSnapshot().name == "AirBridge Device")
    } finally {
        eng.stop()
    }
    if (modelFailed > 0) error("ModelTest failed ($modelFailed checks)")
}

fun main() {
    runModelChecks()
    println("ModelTest: $modelPassed passed, $modelFailed failed")
    if (modelFailed > 0) exitProcess(1)
}
