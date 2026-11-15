// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

describe("Android native Compose & background layout", () => {
  it("renders a full edge-to-edge Compose activity without WebView chrome workarounds", () => {
    const activity = read("android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt");
    expect(activity).toContain("class MainActivity : ComponentActivity()");
    expect(activity).toContain("enableEdgeToEdge(");
    expect(activity).toContain("SystemBarStyle.dark(Color.TRANSPARENT)");
    expect(activity).toContain("SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)");
    expect(activity).toContain("setContent {");
    expect(activity).not.toContain("WebView");

    const app = read("android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt");
    expect(app).toContain("contentWindowInsets = WindowInsets.safeDrawing");
    expect(app).toContain("SnackbarHost(hostState = snackbarHostState)");
    expect(app).toContain("NavigationBar");
    expect(app).toContain("NavigationRail");

    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
    expect(manifest).toContain('android:foregroundServiceType="connectedDevice|dataSync"');
  });

  it("centre-crops the QR preview instead of stretching the camera", () => {
    const scanner = read("android/app/src/main/kotlin/com/airbridge/app/QrScannerView.kt");
    expect(scanner).toContain("class AspectPreview");
    expect(scanner).toContain("preview.aspectRatio = previewAspect(info)");
    expect(scanner).toContain("installChromeInsets()");
    expect(scanner).toContain("fun applyChromeInsets(insets: SystemBarInsets)");
  });

  it("uses safe areas and keeps header actions reachable on narrow desktop web screens", () => {
    const css = read("src/client/index.css");
    expect(css).toContain("--ab-safe-top: env(safe-area-inset-top, 0px)");
    expect(css).toContain("html.ab-native-shell { --ab-safe-top: 0px;");
    expect(css).toContain("@media (max-width: 920px)");
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain("@media (max-width: 480px)");
    expect(css).toContain("--ab-safe-left");
    expect(css).toContain("--ab-gutter");
    expect(css).toContain(".header-count { display: none; }");
    expect(css).toContain(".settings-modal .advanced-toggle");
  });

  it("applies IME and safe-area padding on the native Compose connect screen", () => {
    const connect = read("android/app/src/main/kotlin/com/airbridge/app/ui/screens/ConnectScreen.kt");
    expect(connect).toContain("BoxWithConstraints(");
    expect(connect).toContain(".imePadding()");
    expect(connect).toContain("maxWidth >= 840.dp");
    expect(connect).toContain("widthIn(max = 1040.dp)");
  });

  it("keeps clipboard sharing alive without open app UIs", () => {
    const server = read("src/server/index.ts");
    expect(server).toContain("startBackgroundClipboardPeer");
    expect(server).toContain("/api/daemon/background-pair-code");

    const service = read("android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt");
    expect(service).toContain("OnPrimaryClipChangedListener");
    expect(service).toContain("publishLocalClipboard");
    expect(service).toContain("fun publishClipboardChange");
    expect(service).toContain("accessibilityClipboardOptIn");

    const app = read("src/client/App.tsx");
    expect(app).toContain("__airbridgeNativeClipboard");
    expect(app).toContain("background-pair-code");

    const prefs = read("android/app/src/main/kotlin/com/airbridge/app/Prefs.kt");
    expect(prefs).toContain('getBoolean("connectionContinuity", true)');
  });

  it("reads system-bar and cutout insets correctly in SystemBarInsets helper", () => {
    const helper = read(
      "android/app/src/main/kotlin/com/airbridge/app/SystemBarInsets.kt",
    );
    expect(helper).toContain("data class SystemBarInsets");
    expect(helper).toContain("WindowInsets.Type.systemBars()");
    expect(helper).toContain("WindowInsets.Type.displayCutout()");
    expect(helper).not.toContain("WindowInsets.Type.ime()");
  });

  it("requires an explicit, user-enabled Accessibility Service opt-in", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain("BIND_ACCESSIBILITY_SERVICE");
    expect(manifest).toContain(".ClipboardAccessibilityService");
    expect(manifest).toContain("@xml/accessibility_service_config");

    const config = read("android/app/src/main/res/xml/accessibility_service_config.xml");
    expect(config).toContain('android:canRetrieveWindowContent="false"');
    expect(config).toContain('android:description="@string/accessibility_service_description"');
    expect(config).not.toContain("typeAllMask");

    const strings = read("android/app/src/main/res/values/strings.xml");
    expect(strings).toContain("AirBridge clipboard bridge");
    expect(strings).toContain("cannot enable this service itself");

    const prefs = read("android/app/src/main/kotlin/com/airbridge/app/Prefs.kt");
    expect(prefs).toContain('getBoolean("accessibilityClipboardOptIn", false)');

    const service = read(
      "android/app/src/main/kotlin/com/airbridge/app/ClipboardAccessibilityService.kt",
    );
    expect(service).toContain("accessibilityClipboardOptIn");
    expect(service).toContain("connectionContinuity");
    expect(service).toContain("publishClipboardChange");
    expect(service).not.toContain("getRootInActiveWindow");

    const vm = read("android/app/src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt");
    expect(vm).toContain("fun setAccessibilityOptIn(enabled: Boolean)");
    expect(vm).toContain("ClipboardAccessibilityService.isEnabled");

    const settings = read("android/app/src/main/kotlin/com/airbridge/app/ui/screens/SettingsScreen.kt");
    expect(settings).toContain("onSetAccessibilityOptIn");
    expect(settings).toContain("onOpenAccessibilitySettings");
    expect(settings).toContain("Accessibility service is active");

    const activity = read("android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt");
    expect(activity).toContain("Settings.ACTION_ACCESSIBILITY_SETTINGS");
  });
});
