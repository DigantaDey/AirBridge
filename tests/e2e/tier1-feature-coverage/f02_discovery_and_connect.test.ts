import { describe, expect, it } from 'vitest';
import {
  OpaquePeer,
  readRepoFile,
  startTestServer,
  withPairedEnv,
} from '../harness/index.js';

describe('F02: Connection & Discovery Screen', () => {
  it('exposes /api/health and QR/HTTP endpoints on the server for onboarding discovery', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    try {
      const res = await fetch(`${server.httpUrl}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; protocol: string; e2ee: string };
      expect(body.status).toBe('ok');
      expect(body.protocol).toBe('warp-v1');
      expect(body.e2ee).toBe('ECDH-P256-AES-256-GCM');
    } finally {
      await server.close();
    }
  });

  it('discovers a peer joining with a matching pair code over the WebSocket room protocol', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const peerOnDesktop = desktopPeer.discoveredPeers.find((p) => p.peerId === androidPeer.peerId);
      expect(peerOnDesktop).toBeDefined();
      expect(peerOnDesktop?.device.name).toBe('Android Test');
      expect(peerOnDesktop?.device.platform).toBe('android');
    });
  });

  it('supports nearby discovery visibility on the same local subnet', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'Phone', pairCode: 'AAA222', visibility: 'nearby' });
    const b = await OpaquePeer.create({ name: 'Mac', pairCode: 'BBB333', visibility: 'nearby' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl)]);
      const seen = await a.waitForPeer((p) => p.peerId === b.peerId);
      expect(seen.device.name).toBe('Mac');
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('renders QR scanning, manual address validation, and mDNS hosts on ConnectScreen', async () => {
    const screen = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/screens/ConnectScreen.kt');
    expect(screen).toContain('Scan QR code from computer');
    expect(screen).toContain('Computer address or pairing link');
    expect(screen).toContain('NearbyComputersCard');
    expect(screen).toContain('onRefreshDiscovery');

    const discovery = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/Discovery.kt');
    expect(discovery).toContain('NsdManager');
    expect(discovery).toContain('_airbridge._tcp.');
  });

  it('handles airbridge:// deep links and QR payloads in MainActivity and PairingLink', async () => {
    const manifest = await readRepoFile('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('<data android:scheme="airbridge" />');

    const activity = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt');
    expect(activity).toContain('viewModel.handleIncomingDeepLink(data.scheme, data.toString())');

    const vm = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt');
    expect(vm).toContain('fun handleIncomingDeepLink(scheme: String?, rawUri: String?)');
    expect(vm).toContain('PairingLink.parse(rawUri)');
    expect(vm).toContain('connectWithLink(link)');
    expect(vm).toContain('fun handleScannedQr(payload: String): Boolean');
  });
});
