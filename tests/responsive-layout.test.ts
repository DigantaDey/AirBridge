// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

describe("responsive Android web UI", () => {
  it("uses fluid gutters and all four safe-area insets", () => {
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

  it("has breakpoints for compact, small and very small screens", () => {
    const css = read("src/client/index.css");
    expect(css).toContain("@media (max-width: 920px)");
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain("@media (max-width: 480px)");
    expect(css).toContain(".header-count { display: none; }");
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain(".settings-modal .advanced-toggle");
  });

  it("prevents horizontal overflow and long text clipping", () => {
    const css = read("src/client/index.css");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("min-width: 0");
    expect(css).toContain(
      "max-width: min(360px, calc(100% - var(--ab-gutter) - var(--ab-gutter)))",
    );
    expect(css).toContain("max-height: calc(100dvh - 40px)");
    expect(css).toContain("overscroll-behavior: contain");
  });

  it("applies decor-view insets to the WebView container and QR scanner", () => {
    const activity = read(
      "android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt",
    );
    expect(activity).toContain("window.decorView.setOnApplyWindowInsetsListener");
    expect(activity).toContain("setDecorFitsSystemWindows(false)");
    expect(activity).toContain("isNavigationBarContrastEnforced = false");
    expect(activity).toContain("Color.TRANSPARENT");
    expect(activity).toContain("contentFrame = FrameLayout(this)");
    expect(activity).toContain("installSystemBarInsets(contentFrame)");
    expect(activity).toContain("WindowInsets.CONSUMED");
    expect(activity).toContain("scanner?.applyChromeInsets(bars)");
    expect(activity).toContain("insets.systemBarInsets()");
    expect(activity).toContain("injectNativeShellShim(view)");
    expect(activity).toContain("onPageCommitVisible(view: WebView, url: String)");
    expect(activity).toContain("registerSystemBackCallback()");
    expect(activity).toContain("__airbridgeSystemBack");
    expect(activity).not.toContain("installSystemBarInsets(webView)");

    const scanner = read(
      "android/app/src/main/kotlin/com/airbridge/app/QrScannerView.kt",
    );
    expect(scanner).toContain("installChromeInsets()");
    expect(scanner).toContain("fun applyChromeInsets(insets: SystemBarInsets)");
    expect(scanner).toContain("insets.systemBarInsets()");
    expect(scanner).not.toContain("WindowInsets.Type.systemBars()");

    const helper = read(
      "android/app/src/main/kotlin/com/airbridge/app/SystemBarInsets.kt",
    );
    expect(helper).toContain("data class SystemBarInsets");
    expect(helper).toContain("WindowInsets.Type.systemBars()");
    expect(helper).toContain("WindowInsets.Type.displayCutout()");
    expect(helper).not.toContain("WindowInsets.Type.ime()");
  });

  it("keeps the unpaired connect screen responsive", () => {
    const connect = read("android/app/src/main/assets/shell/connect.html");
    expect(connect).toContain("--ab-safe-left");
    expect(connect).toContain("--ab-gutter: clamp(");
    expect(connect).toContain("@media (max-width: 420px)");
    expect(connect).toContain("@media (max-width: 480px)");
    expect(connect).toContain("html.ab-native-shell");
    expect(connect).toContain("__airbridgeSystemBack");
    expect(connect).not.toContain("100vw");
  });
});
