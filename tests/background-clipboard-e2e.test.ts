// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
    const provider: HostClipboardProvider = {
      isSupported: () => true,
      readText: async () => hostClipboard,
      writeText: async (text: string) => {
        hostClipboard = text;
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

      hostClipboard = 'copied while no UI is open';
      await waitFor(() => received, (text) => text === hostClipboard);
      expect(received).toBe('copied while no UI is open');
    } finally {
      phone.stop();
      await server.close();
      if (originalStorage) {
        Object.defineProperty(globalThis, 'localStorage', originalStorage);
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
      }
    }
  }, 20_000);
});
