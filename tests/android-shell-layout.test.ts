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
    expect(service).not.toContain("accessibilityClipboardOptIn");

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

  it("keeps clipboard send explicit and excludes privileged Accessibility APIs", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).not.toContain("BIND_ACCESSIBILITY_SERVICE");
    expect(manifest).not.toContain(".ClipboardAccessibilityService");
    expect(manifest).not.toContain("BIND_NOTIFICATION_LISTENER_SERVICE");

    const settings = read("android/app/src/main/kotlin/com/airbridge/app/ui/screens/SettingsScreen.kt");
    expect(settings).toContain("Share or Process text → AirBridge");
    expect(settings).toContain("Quick Settings tile");
    expect(settings).toContain("Android may block hidden clipboard reads");

    const clipboard = read("android/app/src/main/kotlin/com/airbridge/app/ui/screens/ClipboardScreen.kt");
    expect(clipboard).toContain("never uses Accessibility");
    expect(clipboard).toContain("Process text → AirBridge");
  });
});
