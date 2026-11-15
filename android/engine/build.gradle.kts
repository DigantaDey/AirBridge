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
val vectorTest by tasks.registering(JavaExec::class) {
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
val pairingLinkTest by tasks.registering(JavaExec::class) {
    group = "verification"
    description = "Runs the QR / pairing-address parser checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.PairingLinkTestKt"
    outputs.upToDateWhen { false }
}

tasks.named("check") {
    dependsOn(vectorTest, pairingLinkTest)
}

val filesTest by tasks.registering(JavaExec::class) {
    group = "verification"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.FilesTestKt"
    outputs.upToDateWhen { false }
}
val transportTest by tasks.registering(JavaExec::class) {
    group = "verification"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.TransportTestKt"
    outputs.upToDateWhen { false }
}
val milestone1Test by tasks.registering(JavaExec::class) {
    group = "verification"
    description = "Runs Milestone 1 packaging, discovery queue, and service invariants checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.Milestone1TestKt"
    outputs.upToDateWhen { false }
}
val milestone2Test by tasks.registering(JavaExec::class) {
    group = "verification"
    description = "Runs Milestone 2 high-speed transfer pipeline, binary SACK, and loopback benchmark checks"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "com.airbridge.engine.Milestone2TestKt"
    outputs.upToDateWhen { false }
}
val interopClasspath by tasks.registering {
    dependsOn(tasks.named("testClasses"))
    doLast {
        layout.buildDirectory.file("interop-classpath.txt").get().asFile
            .writeText(sourceSets["test"].runtimeClasspath.asPath)
    }
}
tasks.named("check") { dependsOn(filesTest, transportTest, milestone1Test, milestone2Test, interopClasspath) }
