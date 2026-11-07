// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

describe("Android shell layout", () => {
  it("stops WebView from zooming out when the header overflows", () => {
    const activity = read("android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt");
    expect(activity).toContain("settings.loadWithOverviewMode = false");
    expect(activity).toContain("installSystemBarInsets(webView)");
    expect(activity).toContain("window.decorView.setOnApplyWindowInsetsListener");
    expect(activity).toContain("setDecorFitsSystemWindows(false)");
    expect(activity).toContain("fun setDarkTheme(enabled: Boolean)");
  });

  it("centre-crops the QR preview instead of stretching the camera", () => {
    const scanner = read("android/app/src/main/kotlin/com/airbridge/app/QrScannerView.kt");
    expect(scanner).toContain("class AspectPreview");
    expect(scanner).toContain("preview.aspectRatio = previewAspect(info)");
    expect(scanner).toContain("installChromeInsets()");
    expect(scanner).toContain("fun applyChromeInsets(insets: SystemBarInsets)");
  });

  it("uses safe areas and keeps header actions reachable on narrow screens", () => {
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

  it("applies the same safe-area rules to the unpaired connect screen", () => {
    const connect = read("android/app/src/main/assets/shell/connect.html");
    expect(connect).toContain("--ab-safe-top: env(safe-area-inset-top, 0px)");
    expect(connect).toContain("html.ab-native-shell");
    expect(connect).toContain("--ab-safe-left");
    expect(connect).toContain("@media (max-width: 420px)");
    expect(connect).toContain("@media (max-width: 480px)");
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

  it("reads system-bar, cutout and IME insets from the decor view", () => {
    const helper = read(
      "android/app/src/main/kotlin/com/airbridge/app/SystemBarInsets.kt",
    );
    expect(helper).toContain("data class SystemBarInsets");
    expect(helper).toContain("WindowInsets.Type.systemBars()");
    expect(helper).toContain("WindowInsets.Type.displayCutout()");
    expect(helper).toContain("WindowInsets.Type.ime()");
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

    const bridge = read("android/app/src/main/kotlin/com/airbridge/app/ShellBridge.kt");
    expect(bridge).toContain("accessibilityOptInEnabled");
    expect(bridge).toContain("openAccessibilitySettings");

    const activity = read("android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt");
    expect(activity).toContain("__airbridgeNativeAccessibilityState");

    const nativeShell = read("src/client/engine/nativeShell.ts");
    expect(nativeShell).toContain("getNativeAccessibilityOptIn");
    expect(nativeShell).toContain("openNativeAccessibilitySettings");

    const app = read("src/client/App.tsx");
    expect(app).toContain("Accessibility-assisted clipboard capture");
    expect(app).toContain("openNativeAccessibilitySettings");
    expect(app).toContain("accessibilityServiceEnabled");
  });
});
