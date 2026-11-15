import { describe, expect, it } from 'vitest';
import {
  hasPermission,
  OpaquePeer,
  readAndroidManifest,
  readRepoFile,
  startTestServer,
} from '../harness/index.js';

describe('F15: Battery Optimization Exemption Contract', () => {
  it('does not declare REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission in AndroidManifest.xml for Play policy compliance', async () => {
    const manifest = await readAndroidManifest();
    expect(hasPermission(manifest, 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS')).toBe(false);
  });

  it('implements requestBatteryExemption() routing via system settings in MainActivity', async () => {
    const activity = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt');
    expect(activity).toContain('private fun requestBatteryExemption()');
    expect(activity).toContain('power.isIgnoringBatteryOptimizations(packageName)');
    expect(activity).toContain('Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
  });

  it('computes batteryExempt dynamically in AirBridgeViewModel from PowerManager', async () => {
    const vm = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt',
    );
    expect(vm).toContain('isIgnoringBatteryOptimizations(appContext.packageName)');
    expect(vm).toContain('batteryExempt');
  });

  it('surfaces battery optimization status and action callback on both TransfersScreen and SettingsScreen', async () => {
    const transfers = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/ui/screens/TransfersScreen.kt',
    );
    const settings = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/ui/screens/SettingsScreen.kt',
    );
    expect(transfers).toContain('onRequestBatteryExemption: () -> Unit');
    expect(settings).toContain('onRequestBatteryExemption: () -> Unit');
    expect(settings).toContain('Battery optimization');
  });

  it('wires MainActivity onRequestBatteryExemption into AirBridgeApp without leaking Activity context', async () => {
    const activity = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt');
    const app = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt');
    expect(activity).toContain('onRequestBatteryExemption = ::requestBatteryExemption');
    expect(app).toContain('onRequestBatteryExemption = onRequestBatteryExemption');
  });

  it('keeps paired signaling sessions responsive without idle disconnects across multiple ping-less exchanges', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'ExemptPhone', platform: 'android', pairCode: 'BEX123' });
    const b = await OpaquePeer.create({ name: 'MacBook', platform: 'macos', pairCode: 'BEX123' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl)]);
      await a.waitForPeer((p) => p.peerId === b.peerId);
      for (let i = 0; i < 3; i++) {
        await a.sendControl(b.peerId, {
          kind: 'clipboard-beam',
          beamId: `clip-idle-${i}`,
          contentType: 'text',
          text: `alive-${i}`,
          timestamp: Date.now(),
        });
        const evt = await b.waitForControl(
          (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === `clip-idle-${i}`,
        );
        expect(evt.payload.kind).toBe('clipboard-beam');
      }
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });
});
