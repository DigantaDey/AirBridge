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
  timeoutMs = 8_000,
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
    const writes: string[] = [];
    let suspendedUi: WebSocket | undefined;
    const provider: HostClipboardProvider = {
      isSupported: () => true,
      readText: async () => hostClipboard,
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
      expect(Object.getOwnPropertyDescriptor(globalThis, 'localStorage')).toEqual(originalStorage);
      hostClipboard = 'copied while no UI is open';
      await waitFor(() => received, (text) => text === hostClipboard);
      expect(received).toBe('copied while no UI is open');
      const daemon = (await waitFor(() => phone.getSnapshot().peers, (peers) => peers.some((peer) => peer.device.model === 'AirBridge service')))
        .find((peer) => peer.device.model === 'AirBridge service')!;
      await phone.sendClipboard(daemon.peerId, '  incoming whitespace\n');
      await waitFor(() => hostClipboard, (value) => value === '  incoming whitespace\n');
      expect(writes).toEqual(['  incoming whitespace\n']); // no duplicate server/daemon OS write
      const prefsResponse = await fetch(`http://127.0.0.1:${server.port}/api/daemon/background-pair-code`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairCode, autoClipboard: false, receiveClipboard: false }),
      });
      expect(prefsResponse.status).toBe(200);
      await phone.sendClipboard(daemon.peerId, 'blocked receive');
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
  }, 20_000);
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

});
