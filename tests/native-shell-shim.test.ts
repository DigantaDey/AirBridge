// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

function collectKotlinFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectKotlinFiles(full));
    else if (entry.name.endsWith(".kt")) results.push(full);
  }
  return results;
}

describe("Native Compose app replacement for Android WebView shell", () => {
  it("contains zero WebView, JavascriptInterface, LoopbackRelay, or ShellBridge code", () => {
    const appSrc = path.join(root, "android/app/src/main/kotlin");
    const kotlinFiles = collectKotlinFiles(appSrc);
    expect(kotlinFiles.length).toBeGreaterThanOrEqual(10);

    for (const file of kotlinFiles) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("@JavascriptInterface");
      expect(source).not.toContain("import android.webkit.WebView");
      expect(source).not.toContain("LoopbackRelay");
      expect(source).not.toContain("ShellBridge");
    }

    expect(existsSync(path.join(root, "android/app/src/main/assets/shell"))).toBe(false);
  });

  it("hosts pure Compose UI in MainActivity with direct ViewModel and foreground service bindings", () => {
    const activity = read("android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt");
    expect(activity).toContain("class MainActivity : ComponentActivity()");
    expect(activity).toContain("setContent {");
    expect(activity).toContain("enableEdgeToEdge(");
    expect(activity).toContain("AirBridgeApp(");
    expect(activity).toContain("ConnectionService.ACTION_UI_ATTACH");
    expect(activity).toContain("ConnectionService.ACTION_UI_DETACH");

    const gradle = read("android/app/build.gradle.kts");
    expect(gradle).toContain("compose = true");
  });

  it("handles system Back, edge-to-edge safe drawing insets, and dialogs in AirBridgeApp", () => {
    const app = read("android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt");
    expect(app).toContain("contentWindowInsets = WindowInsets.safeDrawing");
    expect(app).toContain("BackHandler(");
    expect(app).toContain("QrScannerScreen(");
    expect(app).toContain("TransferOfferDialog(");
    expect(app).toContain("PairingSheet(");
  });
});
