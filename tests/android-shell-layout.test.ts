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
    expect(activity).toContain("fun setDarkTheme(enabled: Boolean)");
  });

  it("centre-crops the QR preview instead of stretching the camera", () => {
    const scanner = read("android/app/src/main/kotlin/com/airbridge/app/QrScannerView.kt");
    expect(scanner).toContain("class AspectPreview");
    expect(scanner).toContain("preview.aspectRatio = previewAspect(info)");
    expect(scanner).toContain("installChromeInsets()");
  });

  it("uses safe areas and keeps header actions reachable on narrow screens", () => {
    const css = read("src/client/index.css");
    expect(css).toContain("--ab-safe-top: env(safe-area-inset-top, 0px)");
    expect(css).toContain("html.ab-native-shell { --ab-safe-top: 0px;");
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain(".header-count { display: none; }");
    expect(css).toContain(".settings-modal .advanced-toggle");
  });

  it("applies the same safe-area rules to the unpaired connect screen", () => {
    const connect = read("android/app/src/main/assets/shell/connect.html");
    expect(connect).toContain("--ab-safe-top: env(safe-area-inset-top, 0px)");
    expect(connect).toContain("html.ab-native-shell");
    expect(connect).toContain("@media (max-width: 420px)");
  });

  it("keeps clipboard sharing alive without open app UIs", () => {
    const server = read("src/server/index.ts");
    expect(server).toContain("startBackgroundClipboardPeer");
    expect(server).toContain("/api/daemon/background-pair-code");

    const service = read("android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt");
    expect(service).toContain("OnPrimaryClipChangedListener");
    expect(service).toContain("publishLocalClipboard");

    const app = read("src/client/App.tsx");
    expect(app).toContain("__airbridgeNativeClipboard");
    expect(app).toContain("background-pair-code");

    const prefs = read("android/app/src/main/kotlin/com/airbridge/app/Prefs.kt");
    expect(prefs).toContain('getBoolean("connectionContinuity", true)');
  });
});
