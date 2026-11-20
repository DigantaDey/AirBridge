import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

/**
 * A Play upload key is deliberately local/secret-only. The previous committed
 * sideload keystore could prove package continuity but could not prove who
 * published an APK. `bundleRelease` now refuses to run without a real private
 * upload key; see android/keystore.properties.example and docs/PLAY_STORE_RELEASE.md.
 */
val signingProperties = Properties().apply {
    val localFile = rootProject.file("keystore.properties")
    if (localFile.isFile) localFile.inputStream().use(::load)
}
fun signingValue(name: String): String? = System.getenv(name)
    ?: signingProperties.getProperty(name)?.trim()?.takeIf { it.isNotEmpty() }

val releaseKeystore = signingValue("AIRBRIDGE_KEYSTORE_FILE")
val releaseStorePassword = signingValue("AIRBRIDGE_KEYSTORE_PASSWORD")
val releaseKeyAlias = signingValue("AIRBRIDGE_KEYSTORE_ALIAS")
val releaseKeyPassword = signingValue("AIRBRIDGE_KEYSTORE_KEY_PASSWORD")
val hasReleaseSigning = listOf(releaseKeystore, releaseStorePassword, releaseKeyAlias, releaseKeyPassword).all { !it.isNullOrBlank() }

android {
    namespace = "com.airbridge.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.airbridge.app"
        minSdk = 26
        targetSdk = 35

        val configuredVersionCode = System.getenv("AIRBRIDGE_VERSION_CODE")?.toIntOrNull()
        val gitCommitCount = runCatching {
            providers.exec {
                commandLine("git", "rev-list", "--count", "HEAD")
            }.standardOutput.asText.get().trim().toIntOrNull()
        }.getOrNull() ?: 0

        // A shallow clone undercounts the commit history, which would mint a
        // version code lower than any real build and trip
        // INSTALL_FAILED_VERSION_DOWNGRADE on the next install. Fail loudly
        // instead; CI checks out with fetch-depth: 0. (No git at all — e.g. an
        // exported source tarball — is not shallow and keeps building.)
        if (configuredVersionCode == null) {
            val shallow = runCatching {
                providers.exec {
                    commandLine("git", "rev-parse", "--is-shallow-repository")
                }.standardOutput.asText.get().trim()
            }.getOrNull()
            if (shallow == "true") {
                throw GradleException(
                    "Shallow git clone: versionCode needs the full commit history. " +
                        "Run 'git fetch --unshallow' or set AIRBRIDGE_VERSION_CODE explicitly."
                )
            }
        }

        // A stable production floor prevents a local Play bundle from going
        // backwards from the old CI-generated sideload version codes.
        versionCode = configuredVersionCode ?: 2_300_000 + gitCommitCount
        versionName = "2.5.2"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(requireNotNull(releaseKeystore))
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            // Android Studio's standard debug key is intentionally used only
            // for local development. It is never a release fallback.
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
    sourceSets["main"].kotlin.srcDir("src/main/kotlin")
}

// Make an accidental unsigned/public-key Play artifact impossible. Debug and
// engine checks remain runnable without any release secret.
tasks.configureEach {
    val releasePackagingTask = name.startsWith("assembleRelease") || name.startsWith("bundleRelease")
    if (releasePackagingTask) {
        doFirst {
            check(hasReleaseSigning) {
                "Release signing is not configured. Create android/keystore.properties from " +
                    "android/keystore.properties.example, or set the four AIRBRIDGE_KEYSTORE_* variables. " +
                    "Never use android/ci.keystore for a Play upload."
            }
        }
    }
}

dependencies {
    implementation(project(":engine"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.4")

    val composeBom = platform("androidx.compose:compose-bom:2024.11.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // QR encoding & camera pairing scanner (Camera2 + pure-Java ZXing, offline).
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
}
