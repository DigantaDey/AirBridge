plugins {
    id("org.jetbrains.kotlin.jvm")
    java
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// Cross-implementation vector check: expectations are produced by the real
// TypeScript reference (scripts/gen-test-vectors.ts -> src/test/resources).
val vectorTest = tasks.register<JavaExec>("vectorTest") {
    group = "verification"
    description = "Runs the Kotlin-vs-TypeScript protocol vector checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.VectorsTestKt"
    args(
        layout.projectDirectory.file("src/test/resources/vectors.json").asFile.absolutePath,
    )
    // The generator is the source of truth; fail fast if it never ran.
    inputs.file(layout.projectDirectory.file("src/test/resources/vectors.json"))
    outputs.upToDateWhen { false }
}

// Pairing-link parsing (QR payloads and hand-typed desktop addresses) is plain
// JVM logic with no vectors to import, so it ships its own tiny main() runner.
val pairingLinkTest = tasks.register<JavaExec>("pairingLinkTest") {
    group = "verification"
    description = "Runs the QR / pairing-address parser checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.PairingLinkTestKt"
    outputs.upToDateWhen { false }
}

// Hotspot pairing: on-link endpoint ranking, QR alternates/pin, invitation
// staging, multi-address TCP race and connection-failure classification.
// (The live QR → TLS/WSS → welcome flow runs in scripts/test-native-interop.ts.)
val hotspotPairingTest = tasks.register<JavaExec>("hotspotPairingTest") {
    group = "verification"
    description = "Runs hotspot pairing endpoint-selection and failure-classification checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.HotspotPairingTestKt"
    outputs.upToDateWhen { false }
}

// Phone continuity channel: authorization, contacts/call commands, consent and
// credit-based screen flow control (live TS interop: scripts/test-native-interop.ts).
val continuityTest = tasks.register<JavaExec>("continuityTest") {
    group = "verification"
    description = "Runs phone continuity (contacts, calls, screen sharing) channel checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.ContinuityTestKt"
    outputs.upToDateWhen { false }
}

val filesTest = tasks.register<JavaExec>("filesTest") {
    group = "verification"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.FilesTestKt"
    outputs.upToDateWhen { false }
}
val transportTest = tasks.register<JavaExec>("transportTest") {
    group = "verification"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.TransportTestKt"
    outputs.upToDateWhen { false }
}
val milestone1Test = tasks.register<JavaExec>("milestone1Test") {
    group = "verification"
    description = "Runs Milestone 1 packaging, discovery queue, and service invariants checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.Milestone1TestKt"
    outputs.upToDateWhen { false }
}
val tlsSanAndTelemetryTest = tasks.register<JavaExec>("tlsSanAndTelemetryTest") {
    group = "verification"
    description = "Runs AND-08, AND-09 IPv6 SAN, and AND-14 engine telemetry regression checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.TlsSanAndTelemetryTestKt"
    outputs.upToDateWhen { false }
}
val webSocketResilienceTest = tasks.register<JavaExec>("webSocketResilienceTest") {
    group = "verification"
    description = "Runs AND-10 WebSocket stalled-writer, cancellation, bounded DNS, and deadline checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.WebSocketResilienceTestKt"
    outputs.upToDateWhen { false }
}
val modelTest = tasks.register<JavaExec>("modelTest") {
    group = "verification"
    description = "Runs AND-20 DeviceProfile sanitization checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.ModelTestKt"
    outputs.upToDateWhen { false }
}
val resilienceAndContinuityAudioTest = tasks.register<JavaExec>("resilienceAndContinuityAudioTest") {
    group = "verification"
    description = "Runs long-transfer resume, completed-ack, call audio, and keyframe PLI checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.ResilienceAndContinuityAudioTestKt"
    outputs.upToDateWhen { false }
}
val milestone2Test = tasks.register<JavaExec>("milestone2Test") {
    group = "verification"
    description = "Runs Milestone 2 high-speed transfer pipeline, binary SACK, and loopback benchmark checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.Milestone2TestKt"
    outputs.upToDateWhen { false }
    mustRunAfter(
        vectorTest,
        pairingLinkTest,
        hotspotPairingTest,
        continuityTest,
        filesTest,
        transportTest,
        milestone1Test,
        tlsSanAndTelemetryTest,
        webSocketResilienceTest,
        modelTest,
        resilienceAndContinuityAudioTest,
    )
}
val interopClasspath = tasks.register("interopClasspath") {
    dependsOn(tasks.named("testClasses"))
    doLast {
        layout.buildDirectory.file("interop-classpath.txt").get().asFile
            .writeText(sourceSets["test"].runtimeClasspath.asPath)
    }
}

tasks.named<Test>("test") {
    // Gradle 9+ added Test.failOnNoDiscoveredTests; configure reflectively so Gradle 8.x also compiles.
    runCatching {
        val prop = javaClass.getMethod("getFailOnNoDiscoveredTests").invoke(this)
        prop.javaClass.getMethod("set", Any::class.java).invoke(prop, false)
    }
}

tasks.named("check") {
    dependsOn(
        vectorTest,
        pairingLinkTest,
        hotspotPairingTest,
        continuityTest,
        filesTest,
        transportTest,
        milestone1Test,
        tlsSanAndTelemetryTest,
        webSocketResilienceTest,
        modelTest,
        resilienceAndContinuityAudioTest,
        milestone2Test,
        interopClasspath,
    )
}
