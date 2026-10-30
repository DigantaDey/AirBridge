plugins {
    id("org.jetbrains.kotlin.jvm")
}

kotlin {
    jvmToolchain(17)
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

tasks.named("check") {
    dependsOn(vectorTest)
}
