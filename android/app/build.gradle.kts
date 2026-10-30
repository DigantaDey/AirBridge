plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.airbridge.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.airbridge.app"
        minSdk = 26
        targetSdk = 35
        // Releases re-stamp this from the CI run number so every build is an
        // upgrade over the previous sideloaded APK.
        versionCode = System.getenv("AIRBRIDGE_VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = "1.0.0"
    }

    signingConfigs {
        // Committed sideload key: keeps package signatures stable across CI
        // runs so users can install updates over the previous APK. Override
        // with AIRBRIDGE_KEYSTORE_FILE/-PASSWORD/-ALIAS for real distribution.
        val envStore = System.getenv("AIRBRIDGE_KEYSTORE_FILE")
        if (envStore != null) {
            create("release") {
                storeFile = file(envStore)
                storePassword = System.getenv("AIRBRIDGE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("AIRBRIDGE_KEYSTORE_ALIAS")
                keyPassword = System.getenv("AIRBRIDGE_KEYSTORE_KEY_PASSWORD")
            }
        } else {
            create("release") {
                storeFile = rootProject.layout.projectDirectory.file("ci.keystore").asFile
                storePassword = "airbridge-ci"
                keyAlias = "airbridge"
                keyPassword = "airbridge-ci"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
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

// The transfer engine (android/engine) is no longer used by the app: the UI
// is the web client running inside a WebView, which speaks the same protocol
// directly. The engine module is still built and vector-checked on its own.
// The app itself is framework-only (android.*): the WebView loads the web
// client, and the QR scanner page uses getUserMedia + jsQR, so no AndroidX
// camera/appcompat dependencies are needed.
dependencies {
}
