// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

/**
 * Static wiring checks for the Android app (no Android SDK in the desktop
 * job). The behaviour itself is exercised on the JVM by
 * HotspotPairingTestKt (staging/precedence) and QrPairingE2EKt (live QR →
 * pending code → TLS/WSS → welcome against the real server).
 */
describe('Android QR pairing bootstrap wiring', () => {
  const viewModel = read('android/app/src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt');
  const prefs = read('android/app/src/main/kotlin/com/airbridge/app/Prefs.kt');
  const host = read('android/app/src/main/kotlin/com/airbridge/app/NativeEngineHost.kt');
  const service = read('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
  const store = read('android/engine/src/main/kotlin/com/airbridge/engine/PairingInvitationStore.kt');

  it('stages the whole scanned invitation and consumes its code before older saved state', () => {
    expect(viewModel).toContain('prefs.stageInvitation(link)');
    expect(viewModel).not.toContain('prefs.target = ');
    expect(prefs).toContain('fun consumePendingPairCode()');
    expect(prefs).toContain('PairingInvitationStore(');
    expect(store).toContain('kv.putString(KEY_PENDING_PAIR_CODE, link.pairCode.orEmpty())');
    expect(store).toContain('PairingCodeBootstrap.resolve(pendingScanned = pending');
    expect(host).toContain('prefs.invitations.bootstrap()');
    expect(host).toContain('initialPairCode = targetPairCode');
  });

  it('restarts the engine for a rescan of the same computer', () => {
    expect(service).toContain('prefs.invitations.engineKey');
    expect(service).toContain('engineTarget == key');
  });

  it('dials every advertised address and surfaces classified failures', () => {
    expect(host).toContain('endpointHosts = { prefs.invitations.candidateHosts() }');
    expect(host).toContain('override fun onConnectionFailure(diagnosis: ConnectionDiagnosis)');
    expect(host).toContain('prefs.invitations.learn(lanUrls)');
  });

  it('drops a superseded staged code when a QR is joined live', () => {
    expect(viewModel).toMatch(/prefs\.consumePendingPairCode\(\)\s*\n\s*joinPairCode\(link\.pairCode!!\)/);
  });
});
