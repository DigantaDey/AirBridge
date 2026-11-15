// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

describe("native Compose unpaired connect screen", () => {
  it("removes the legacy WebView shell HTML, bridge, and loopback relay", () => {
    expect(existsSync(path.join(root, "android/app/src/main/assets/shell/connect.html"))).toBe(false);
    expect(existsSync(path.join(root, "android/app/src/main/assets/shell/native-shell-shim.js"))).toBe(false);
    expect(existsSync(path.join(root, "android/app/src/main/kotlin/com/airbridge/app/ShellBridge.kt"))).toBe(false);
    expect(existsSync(path.join(root, "android/app/src/main/kotlin/com/airbridge/app/LoopbackRelay.kt"))).toBe(false);
  });

  it("renders native Material 3 onboarding with QR scan, manual entry, and nearby discovery", () => {
    const connect = read("android/app/src/main/kotlin/com/airbridge/app/ui/screens/ConnectScreen.kt");
    expect(connect).toContain("fun ConnectScreen(");
    expect(connect).toContain('"Connect to your computer"');
    expect(connect).toContain('"Scan QR code from computer"');
    expect(connect).toContain('"Computer address or pairing link"');
    expect(connect).toContain("isError = connectError != null");
    expect(connect).toContain("supportingText = connectError?.let");
    expect(connect).toContain("NearbyComputersCard(");
    expect(connect).toContain("onRefreshDiscovery");
    expect(connect).toContain("onConnectNearby");
    expect(connect).toContain(".imePadding()");
  });

  it("wires mDNS discovery, pairing links, camera permission, and theme sync through MainActivity and ViewModel", () => {
    const vm = read("android/app/src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt");
    expect(vm).toContain("fun startDiscovery()");
    expect(vm).toContain("fun refreshDiscovery()");
    expect(vm).toContain("fun connectToAddress(rawAddress: String)");
    expect(vm).toContain("fun connectWithLink(link: PairingLink)");
    expect(vm).toContain("fun handleScannedQr(payload: String): Boolean");
    expect(vm).toContain("fun clearConnectError()");
    expect(vm).toContain("preferredAddressInput");

    const activity = read("android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt");
    expect(activity).toContain("isResolvedDarkTheme(state.themeMode)");
    expect(activity).toContain("applyEdgeToEdge(darkTheme)");
    expect(activity).toContain("openScannerWithPermission");
    expect(activity).toContain("showCameraRationale = true");
    expect(activity).toContain("PairingLink.parse(data.toString())");
    expect(activity).toContain("No camera detected on this device");
  });

  it("clears inline connect errors on system Back via BackHandler", () => {
    const app = read("android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt");
    expect(app).toContain("BackHandler(enabled = !uiState.isPaired && uiState.connectError != null)");
    expect(app).toContain("onInputChanged()");
  });
});
