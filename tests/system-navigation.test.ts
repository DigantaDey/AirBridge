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
    expect(manifest).toContain('android:launchMode="singleTop"');

    const activity = read(
      "android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt",
    );
    expect(activity).toContain("class MainActivity : ComponentActivity()");
  });

  it("routes Compose Back gestures cleanly through QR scanner, inline connect errors, and non-start tabs", () => {
    const qrScreen = read(
      "android/app/src/main/kotlin/com/airbridge/app/ui/components/QrScannerScreen.kt",
    );
    expect(qrScreen).toContain("BackHandler");
    expect(qrScreen).toContain("latestOnClose()");

    const app = read(
      "android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt",
    );
    expect(app).toContain("BackHandler(enabled = !uiState.isPaired && uiState.connectError != null)");
    expect(app).toContain("onInputChanged()");
    expect(app).toContain("destination != AirBridgeDestination.TRANSFERS");
    expect(app).toContain("onSelectDestination(AirBridgeDestination.TRANSFERS)");

    const offerDialog = read(
      "android/app/src/main/kotlin/com/airbridge/app/ui/components/TransferOfferDialog.kt",
    );
    expect(offerDialog).toContain("AlertDialog(");
    expect(offerDialog).toContain("onDismissRequest = onDecline");

    const pairingSheet = read(
      "android/app/src/main/kotlin/com/airbridge/app/ui/components/PairingSheet.kt",
    );
    expect(pairingSheet).toContain("ModalBottomSheet(");
    expect(pairingSheet).toContain("onDismissRequest = onDismiss");
  });

  it("lets the desktop web UI close its topmost layer on Back or Escape", () => {
    const app = read("src/client/App.tsx");
    expect(app).toContain("window.__airbridgeSystemBack = closeTopmostLayer");
    expect(app).toContain('event.key === "Escape"');
    expect(app).toContain("declineIncomingTransfer(activeIncomingOffer.transferId)");

    const nativeShell = read("src/client/engine/nativeShell.ts");
    expect(nativeShell).toContain("__airbridgeSystemBack?: () => boolean");
  });
});
