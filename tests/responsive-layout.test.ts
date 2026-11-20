// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

describe("responsive desktop web and native Android Compose UI", () => {
  it("uses fluid gutters and all four safe-area insets on the desktop web UI", () => {
    const css = read("src/client/index.css");
    expect(css).toMatch(/--ab-gutter:\s*clamp\(/);
    expect(css).toContain("--ab-safe-top: env(safe-area-inset-top, 0px)");
    expect(css).toContain("--ab-safe-right: env(safe-area-inset-right, 0px)");
    expect(css).toContain("--ab-safe-bottom: env(safe-area-inset-bottom, 0px)");
    expect(css).toContain("--ab-safe-left: env(safe-area-inset-left, 0px)");
    expect(css).toContain(
      "html.ab-native-shell { --ab-safe-top: 0px; --ab-safe-right: 0px; --ab-safe-bottom: 0px; --ab-safe-left: 0px; }",
    );
    expect(css).not.toContain("100vw");
  });

  it("has CSS breakpoints for compact, small and very small web screens", () => {
    const css = read("src/client/index.css");
    expect(css).toContain("@media (max-width: 920px)");
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain("@media (max-width: 480px)");
    expect(css).toContain(".header-count { display: none; }");
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain(".settings-modal .advanced-toggle");
  });

  it("prevents horizontal overflow and long text clipping on the web UI", () => {
    const css = read("src/client/index.css");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("min-width: 0");
    expect(css).toContain(
      "max-width: min(360px, calc(100% - var(--ab-gutter) - var(--ab-gutter)))",
    );
    expect(css).toContain("max-height: calc(100dvh - 40px)");
    expect(css).toContain("overscroll-behavior: contain");
  });

  it("adapts Compose navigation (NavigationBar vs NavigationRail) and two-pane layouts by window width", () => {
    const app = read("android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt");
    expect(app).toContain("BoxWithConstraints(modifier = Modifier.fillMaxSize())");
    expect(app).toContain("val useRail = uiState.isPaired && (maxWidth >= 600.dp || maxHeight < 480.dp)");
    expect(app).toContain("NavigationBar");
    expect(app).toContain("NavigationRail(");
    expect(app).toContain("contentWindowInsets = WindowInsets.safeDrawing");

    for (const screen of ["ConnectScreen.kt", "TransfersScreen.kt", "ClipboardScreen.kt"]) {
      const src = read(`android/app/src/main/kotlin/com/airbridge/app/ui/screens/${screen}`);
      expect(src).toContain("BoxWithConstraints(");
      expect(src).toContain("maxWidth >= 840.dp");
    }

    const scanner = read("android/app/src/main/kotlin/com/airbridge/app/QrScannerView.kt");
    expect(scanner).toContain("installChromeInsets()");
    expect(scanner).toContain("fun applyChromeInsets(insets: SystemBarInsets)");
    expect(scanner).toContain("insets.systemBarInsets()");
    expect(scanner).not.toContain("WindowInsets.Type.systemBars()");

    const helper = read("android/app/src/main/kotlin/com/airbridge/app/SystemBarInsets.kt");
    expect(helper).toContain("data class SystemBarInsets");
    expect(helper).toContain("WindowInsets.Type.systemBars()");
    expect(helper).toContain("WindowInsets.Type.displayCutout()");
    expect(helper).not.toContain("WindowInsets.Type.ime()");
  });

  it("applies edge-to-edge system bars and IME padding on Android", () => {
    const activity = read("android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt");
    expect(activity).toContain("enableEdgeToEdge(");
    expect(activity).toContain("Color.TRANSPARENT");
    expect(activity).toContain("SystemBarStyle.dark");
    expect(activity).toContain("SystemBarStyle.light");

    const app = read("android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt");
    expect(app).toContain("contentWindowInsets = WindowInsets.safeDrawing");
    expect(app).toContain(".consumeWindowInsets(innerPadding)");

    const clipboard = read("android/app/src/main/kotlin/com/airbridge/app/ui/screens/ClipboardScreen.kt");
    expect(clipboard).toContain("contentPadding.calculateBottomPadding()");

    const pairingSheet = read("android/app/src/main/kotlin/com/airbridge/app/ui/components/PairingSheet.kt");
    expect(pairingSheet).toContain(".imePadding()");

    const connect = read("android/app/src/main/kotlin/com/airbridge/app/ui/screens/ConnectScreen.kt");
    expect(connect).toContain(".imePadding()");
  });
});
