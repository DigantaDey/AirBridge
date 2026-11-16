// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

describe('Android QR pairing bootstrap wiring', () => {
  it('stages the scanned QR code and consumes it before falling back to old saved pairing state', () => {
    const viewModel = read('android/app/src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt');
    const prefs = read('android/app/src/main/kotlin/com/airbridge/app/Prefs.kt');
    const host = read('android/app/src/main/kotlin/com/airbridge/app/NativeEngineHost.kt');

    expect(viewModel).toContain('prefs.pendingPairCode = link.pairCode.orEmpty()');
    expect(prefs).toContain('fun consumePendingPairCode()');
    expect(host).toContain('val pendingScannedCode = prefs.consumePendingPairCode()');
    expect(host).toContain('PairingCodeBootstrap.resolve(');
    expect(host).toContain('initialPairCode = targetPairCode');
  });
});
