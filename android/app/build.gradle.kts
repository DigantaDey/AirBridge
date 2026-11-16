plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.airbridge.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.airbridge.app"
        minSdk = 26
        targetSdk = 35

        val ciRunNumber = System.getenv("AIRBRIDGE_VERSION_CODE")?.toIntOrNull()
        val gitCommitCount = runCatching {
            providers.exec {
                commandLine("git", "rev-list", "--count", "HEAD")
            }.standardOutput.asText.get().trim().toIntOrNull()
        }.getOrNull() ?: 100

        versionCode = when {
            ciRunNumber != null -> 100000 + ciRunNumber
            else -> 100000 + gitCommitCount
        }
        versionName = "0.0.1-alpha"
    }

    signingConfigs {
        // Committed sideload key: keeps package signatures stable across CI
        // runs and local debug builds so users and developers can install updates
        // without signature collisions (INSTALL_FAILED_UPDATE_INCOMPATIBLE).
        create("ciSideload") {
            storeFile = rootProject.layout.projectDirectory.file("ci.keystore").asFile
            storePassword = "airbridge-ci"
            keyAlias = "airbridge"
            keyPassword = "airbridge-ci"
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }

        // Production release signing config overridden via environment variables
        val envStore = System.getenv("AIRBRIDGE_KEYSTORE_FILE")
        if (envStore != null) {
            create("release") {
                storeFile = file(envStore)
                storePassword = System.getenv("AIRBRIDGE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("AIRBRIDGE_KEYSTORE_ALIAS")
                keyPassword = System.getenv("AIRBRIDGE_KEYSTORE_KEY_PASSWORD")
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("ciSideload")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("ciSideload")
        }
    }

    buildFeatures {
        compose = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    sourceSets["main"].kotlin.srcDir("src/main/kotlin")
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
}
