// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostClipboardMonitor, type HostClipboardProvider } from '../src/server/hostClipboard.js';
import { WarpClient, type ClipboardBeamItem } from '../src/client/engine/warpClient.js';
import type { PeerSummary } from '../src/shared/protocol.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => { vi.useRealTimers(); });

describe('clipboard ordering, retry and bounded work', () => {
  it('coalesces slow OS writes to the in-flight and latest value only', async () => {
    const gate = deferred();
    const writes: string[] = [];
    const provider: HostClipboardProvider = {
      isSupported: () => true,
      readText: async () => '',
      writeText: async (text) => { writes.push(text); if (text === 'first') await gate.promise; return true; },
    };
    const monitor = new HostClipboardMonitor({ provider, onClipboardChange: () => {} });
    try {
      const first = monitor.writeClipboard('first');
      const queued = Array.from({ length: 1_000 }, (_, i) => monitor.writeClipboard(`pending-${i}`));
      expect(writes).toEqual(['first']);
      gate.resolve();
      expect(await first).toBe(true);
      const results = await Promise.all(queued);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(writes).toEqual(['first', 'pending-999']);
    } finally { gate.resolve(); monitor.close(); }
  });

  it('does not suppress a later local copy after an OS write fails, or trim meaningful whitespace', async () => {
    vi.useFakeTimers();
    let clipboard = 'seed';
    const changes: string[] = [];
    const provider: HostClipboardProvider = {
      isSupported: () => true, readText: async () => clipboard, writeText: async () => false,
    };
    const monitor = new HostClipboardMonitor({ provider, pollIntervalMs: 50, onClipboardChange: (text) => changes.push(text) });
    try {
      monitor.setShouldWatch(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(await monitor.writeClipboard('retry me')).toBe(false);
      clipboard = 'retry me';
      await vi.advanceTimersByTimeAsync(50);
      clipboard = '  retry me\n';
      await vi.advanceTimersByTimeAsync(50);
      clipboard = '';
      await vi.advanceTimersByTimeAsync(50);
      clipboard = '  retry me\n';
      await vi.advanceTimersByTimeAsync(50);
      expect(changes).toEqual(['retry me', '  retry me\n', '  retry me\n']);
    } finally { monitor.close(); }
  });

  it('coalesces browser automatic captures while preserving the newest original text', async () => {
    const client = new WarpClient({ storage: null });
    const state = client as unknown as { connectionState: string; peers: PeerSummary[] };
    state.connectionState = 'connected';
    state.peers = [{ peerId: '1111111111111111', discoveryScope: 'paired', device: { publicKey: 'key' } } as PeerSummary];
    const gate = deferred();
    const send = vi.spyOn(client, 'sendClipboard').mockImplementation(async (_peer, text) => {
      if (text === 'first') await gate.promise;
      return { text } as ClipboardBeamItem;
    });
    try {
      const first = client.handleDetectedLocalClipboard('first');
      for (let i = 0; i < 100; i++) await client.handleDetectedLocalClipboard(`  latest ${i}\n`);
      expect(send).toHaveBeenCalledTimes(1);
      gate.resolve();
      await first;
      expect(send.mock.calls.map((args) => args[1])).toEqual(['first', '  latest 99\n']);
      expect(client.getLastSyncedClipboardText()).toBe('  latest 99\n');
      await client.handleDetectedLocalClipboard('latest 99');
      expect(send).toHaveBeenLastCalledWith('1111111111111111', 'latest 99', { isAuto: true });
    } finally { gate.resolve(); client.stop(); }
  });

  it('retries only failed automatic destinations instead of swallowing failures or duplicating successes', async () => {
    const client = new WarpClient({ storage: null });
    const state = client as unknown as { connectionState: string; peers: PeerSummary[] };
    state.connectionState = 'connected';
    state.peers = ['a', 'b'].map((id) => ({ peerId: id, discoveryScope: 'paired', device: { publicKey: id } } as PeerSummary));
    let fail = true;
    const send = vi.spyOn(client, 'sendClipboard').mockImplementation(async (id) => {
      if (id === 'b' && fail) throw new Error('network changed');
      return {} as ClipboardBeamItem;
    });
    try {
      await client.handleDetectedLocalClipboard('copy');
      fail = false;
      await client.handleDetectedLocalClipboard('copy');
      expect(send.mock.calls.map((args) => args[0])).toEqual(['a', 'b', 'b']);
      expect(client.getLastSyncedClipboardText()).toBe('copy');
    } finally { client.stop(); }
  });
});
