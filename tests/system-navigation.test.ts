// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

describe("Android system navigation", () => {
  it("opts into OnBackInvokedCallback on Android 13+", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:enableOnBackInvokedCallback="true"');

    const activity = read(
      "android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt",
    );
    expect(activity).toContain("registerSystemBackCallback()");
    expect(activity).toContain("unregisterSystemBackCallback()");
    expect(activity).toContain("OnBackInvokedDispatcher.PRIORITY_DEFAULT");
    expect(activity).toContain("Build.VERSION_CODES.TIRAMISU");
  });

  it("routes Back through scanner, chooser, in-page sheets, history, then exit", () => {
    const activity = read(
      "android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt",
    );
    expect(activity).toContain("closeScanner()");
    expect(activity).toContain("pendingChooser?.onReceiveValue(null)");
    expect(activity).toContain("__airbridgeSystemBack");
    expect(activity).toContain("webView.canGoBack()");
    expect(activity).toContain("webView.goBack()");
    expect(activity).toContain("view.clearHistory()");
  });

  it("lets the web UI close its topmost layer on Back or Escape", () => {
    const app = read("src/client/App.tsx");
    expect(app).toContain("window.__airbridgeSystemBack = closeTopmostLayer");
    expect(app).toContain('event.key === "Escape"');
    expect(app).toContain("declineIncomingTransfer(activeIncomingOffer.transferId)");

    const nativeShell = read("src/client/engine/nativeShell.ts");
    expect(nativeShell).toContain("__airbridgeSystemBack?: () => boolean");
  });

  it("lets the unpaired connect screen clear inline errors on Back", () => {
    const connect = read("android/app/src/main/assets/shell/connect.html");
    expect(connect).toContain("window.__airbridgeSystemBack");
    expect(connect).toContain("back: function ()");
  });
});
