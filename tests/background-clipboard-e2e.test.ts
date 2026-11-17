// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { generateIdentityKeyPair } from '../src/client/engine/crypto.js';
import { createAirBridgeServer } from '../src/server/index.js';
import { WarpClient } from '../src/client/engine/warpClient.js';
import type { HostClipboardProvider } from '../src/server/hostClipboard.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000, // only reached on failure; CI runners can be slow to set up the encrypted peer
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!predicate(last) && Date.now() < deadline) {
    await wait(100);
    last = await probe();
  }
  return last;
}

describe('background clipboard without open browser UIs', () => {
  it('beams an OS clipboard change to a paired phone through the daemon peer', async () => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    let hostClipboard = 'seed clipboard';
    let clipboardReads = 0;
    const writes: string[] = [];
    let suspendedUi: WebSocket | undefined;
    const provider: HostClipboardProvider = {
      isSupported: () => true,
      readText: async () => { clipboardReads += 1; return hostClipboard; },
      writeText: async (text: string) => {
        hostClipboard = text;
        writes.push(text);
        return true;
      },
    };
    const stateFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-background-e2e-')),
      'peer.json',
    );

    const server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      https: false,
      hostClipboard: provider,
      hostClipboardPollMs: 120,
      backgroundClipboard: true,
      backgroundClipboardStoragePath: stateFile,
      receivedFolderSettingsPath: null,
    });

    const pairCode = server.hub.getDefaultPairCode();
    let received = '';
    const phone = new WarpClient({
      wsUrl: `ws://127.0.0.1:${server.port}/ws`,
      initialPairCode: pairCode,
      storagePrefix: 'airbridge:background-e2e-phone',
      enableWebRtc: false,
      deviceOverride: {
        name: 'Background Test Phone',
        platform: 'android',
        model: 'Pixel',
        formFactor: 'phone',
        deviceId: '1111111111111111',
      },
      onIncomingClipboard: (item) => {
        received = item.text;
      },
    });

    try {
      await phone.start();
      await waitFor(() => server.hub.getStats().connectedPeers, (n) => n >= 2);
      expect(server.backgroundClipboard).not.toBeNull();

      const endpoint = await fetch(
        `http://127.0.0.1:${server.port}/api/daemon/background-pair-code`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairCode }),
        },
      );
      expect(endpoint.status).toBe(200);

      // A more recently connected desktop UI never handles host events,
      // just like a frozen/hidden tab. It must not steal daemon OS capture.
      const key = await generateIdentityKeyPair();
      suspendedUi = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      await new Promise<void>((resolve, reject) => {
        suspendedUi!.on('open', () => suspendedUi!.send(JSON.stringify({ type: 'hello', pairCode,
          device: { name: 'Suspended UI', platform: 'macos', model: 'Browser', formFactor: 'laptop', publicKey: key.publicKeyB64 } })));
        suspendedUi!.on('message', () => resolve());
        suspendedUi!.on('error', reject);
      });
      // Wait until the background peer has joined the same encrypted room. A
      // host clipboard poll that happens before that point is retained by the
      // sender, but waiting here makes this test exercise delivery rather than
      // the pairing race itself.
      const daemonClient = (server.backgroundClipboard as unknown as { client: WarpClient }).client;
      const daemonSnapshot = await waitFor(
        () => daemonClient.getSnapshot(),
        (snapshot) => {
          const phonePeer = snapshot.peers.find((peer) => peer.device.deviceId === '1111111111111111');
          return snapshot.connectionState === 'connected' && !!phonePeer &&
            typeof snapshot.peerSecurity[phonePeer.peerId]?.rttMs === 'number';
        },
      );
      const daemonPhonePeer = daemonSnapshot.peers.find((peer) => peer.device.deviceId === '1111111111111111');
      expect(daemonSnapshot.autoClipboardSync).toBe(true);
      expect(daemonPhonePeer).toBeDefined();
      const phoneSnapshot = await waitFor(
        () => phone.getSnapshot(),
        (snapshot) => {
          const daemonPeer = snapshot.peers.find((peer) => peer.device.model === 'AirBridge service');
          return !!daemonPeer && typeof snapshot.peerSecurity[daemonPeer.peerId]?.rttMs === 'number';
        },
      );
      const daemonAtPhone = phoneSnapshot.peers.find((peer) => peer.device.model === 'AirBridge service')!;
      expect(phoneSnapshot.clipboardReceiveEnabled).toBe(true);
      // Ensure the monitor has completed its initial seed poll before changing
      // the clipboard; otherwise a change during the first read is intentionally
      // treated as startup state instead of a new copy event.
      await waitFor(() => clipboardReads, (reads) => reads >= 2);
      expect(Object.getOwnPropertyDescriptor(globalThis, 'localStorage')).toEqual(originalStorage);
      hostClipboard = 'copied while no UI is open';
      await waitFor(() => received, (text) => text === hostClipboard);
      expect(received).toBe('copied while no UI is open');
      await phone.sendClipboard(daemonAtPhone.peerId, '  incoming whitespace\n');
      await waitFor(() => hostClipboard, (value) => value === '  incoming whitespace\n');
      expect(writes).toEqual(['  incoming whitespace\n']); // no duplicate server/daemon OS write
      const prefsResponse = await fetch(`http://127.0.0.1:${server.port}/api/daemon/background-pair-code`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairCode, autoClipboard: false, receiveClipboard: false }),
      });
      expect(prefsResponse.status).toBe(200);
      await phone.sendClipboard(daemonAtPhone.peerId, 'blocked receive');
      hostClipboard = 'disabled automatic capture';
      await wait(300);
      expect(writes).toEqual(['  incoming whitespace\n']);
      expect(received).toBe('copied while no UI is open');

    } finally {
      phone.stop();
      suspendedUi?.close();
      await server.close();
      fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
      if (originalStorage) {
        Object.defineProperty(globalThis, 'localStorage', originalStorage);
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
      }
    }
  // This deliberately exercises encrypted pairing, a polled host clipboard,
  // and a suspended UI socket. Under a fully parallel CI run each bounded
  // readiness wait can consume its own budget, so keep the test-level limit
  // above their combined worst case rather than turning a slow runner into a
  // false functional failure.
  }, 80_000);
  it('restores the startup QR pairing group and disabled clipboard preferences after a daemon restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-background-restart-'));
    const stateFile = path.join(dir, 'peer.json');
    const provider: HostClipboardProvider = { isSupported: () => true, readText: async () => '', writeText: async () => true };
    const options = { port: 0, host: '127.0.0.1', mode: 'test' as const, https: false, enableMdns: false,
      hostClipboard: provider, backgroundClipboard: true, backgroundClipboardStoragePath: stateFile, receivedFolderSettingsPath: null };
    let server = await createAirBridgeServer(options);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/background-pair-code`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairCode: 'ABC234', autoClipboard: false, receiveClipboard: false }),
      });
      expect(response.status).toBe(200);
      await server.close();
      server = await createAirBridgeServer(options);
      expect(server.hub.getDefaultPairCode()).toBe('ABC234');
      const client = (server.backgroundClipboard as unknown as { client: WarpClient }).client;
      expect(client.getSnapshot().autoClipboardSync).toBe(false);
      expect(client.getSnapshot().clipboardReceiveEnabled).toBe(false);
      await waitFor(() => client.getSnapshot().connectionState, (state) => state === 'connected');
      expect(client.getSnapshot().pairCode).toBe('ABC234');
    } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 15_000);

  it('keeps BackgroundClipboardPeer synchronized when a loopback browser joins or rotates pair codes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-pair-sync-'));
    const stateFile = path.join(dir, 'peer.json');
    const provider: HostClipboardProvider = { isSupported: () => true, readText: async () => '', writeText: async () => true };
    const server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      https: false,
      enableMdns: false,
      hostClipboard: provider,
      backgroundClipboard: true,
      backgroundClipboardStoragePath: stateFile,
      receivedFolderSettingsPath: null,
    });
    const bgClient = (server.backgroundClipboard as unknown as { client: WarpClient }).client;
    let browserWs: WebSocket | null = null;
    try {
      await waitFor(() => bgClient.getSnapshot().connectionState, (state) => state === 'connected');
      const key = await generateIdentityKeyPair();
      browserWs = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const messages: Array<{ type: string; pairCode?: string }> = [];
      await new Promise<void>((resolve, reject) => {
        browserWs!.on('message', (data) => {
          const parsed = JSON.parse(String(data)) as { type: string; pairCode?: string };
          messages.push(parsed);
          if (parsed.type === 'welcome') resolve();
        });
        browserWs!.on('open', () => {
          browserWs!.send(
            JSON.stringify({
              type: 'hello',
              device: {
                name: 'Mac Browser',
                platform: 'macos',
                model: 'Browser',
                formFactor: 'laptop',
                publicKey: key.publicKeyB64,
              },
            }),
          );
        });
        browserWs!.on('error', reject);
      });

      browserWs.send(JSON.stringify({ type: 'join-pair', pairCode: 'XYZ789' }));
      await waitFor(() => bgClient.getSnapshot().pairCode, (code) => code === 'XYZ789');

      browserWs.send(JSON.stringify({ type: 'rotate-pair' }));
      await waitFor(
        () => messages.find((m) => m.type === 'pair-updated' && m.pairCode !== 'XYZ789')?.pairCode ?? '',
        (code) => code.length === 6 && code !== 'XYZ789',
      );
      const rotated = messages.find((m) => m.type === 'pair-updated' && m.pairCode !== 'XYZ789')!.pairCode!;
      await waitFor(() => bgClient.getSnapshot().pairCode, (code) => code === rotated);
    } finally {
      browserWs?.close();
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

});
