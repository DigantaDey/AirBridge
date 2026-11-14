import { describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MAX_BROWSER_BUFFERED_BYTES, MAX_CHUNKS_PER_TRANSFER, WarpClient, type ClipboardBeamItem, type TransferSessionView } from '../src/client/engine/warpClient.js';
import type { PeerSummary } from '../src/shared/protocol.js';

type Internals = {
  peers: PeerSummary[];
  connectionState: string;
  clipboardItems: ClipboardBeamItem[];
  pruneClipboardHistory(): void;
  transfers: TransferSessionView[];
  sortTransfers(): void;
};

function fixture() {
  const client = new WarpClient();
  return { client, state: client as unknown as Internals };
}

describe('long-lived client privacy and resource limits', () => {
  it('never auto-shares with merely nearby peers; pairing preserves the original text', async () => {
    const { client, state } = fixture();
    state.connectionState = 'connected';
    state.peers = [{ peerId: '1111111111111111', discoveryScope: 'nearby' } as PeerSummary];
    const send = vi.spyOn(client, 'sendClipboard').mockResolvedValue({} as ClipboardBeamItem);
    const text = '  indented code\n';
    try {
      expect(await client.handleDetectedLocalClipboard(text)).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      state.peers[0].discoveryScope = 'paired';
      await client.handleDetectedLocalClipboard(text);
      expect(send).toHaveBeenCalledExactlyOnceWith('1111111111111111', text, { isAuto: true });
    } finally { client.stop(); }
  });

  it('caps clipboard memory by content budget as well as item count', () => {
    const { client, state } = fixture();
    try {
      const image = 'data:image/png;base64,' + 'A'.repeat(4_100_000);
      state.clipboardItems = Array.from({ length: 20 }, () => ({ text: image, imageDataUrl: image } as ClipboardBeamItem));
      state.pruneClipboardHistory();
      expect(state.clipboardItems).toHaveLength(1); // a single valid large image is allowed
      state.clipboardItems = Array.from({ length: 80 }, () => ({ text: 'small text' } as ClipboardBeamItem));
      state.pruneClipboardHistory();
      expect(state.clipboardItems).toHaveLength(50);
    } finally { client.stop(); }
  });

  it('does not evict active sessions when trimming terminal history, and releases old Blob URLs', () => {
    const { client, state } = fixture();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      const active = Array.from({ length: 70 }, (_, i) => ({ transferId: `active-${i}`, status: 'transferring', startedAt: i } as TransferSessionView));
      const terminal = Array.from({ length: 70 }, (_, i) => ({ transferId: `done-${i}`, status: 'completed', startedAt: i, receivedFiles: [{ blobUrl: `blob:${i}` }] } as TransferSessionView));
      state.transfers = [...active, ...terminal];
      state.sortTransfers();
      expect(state.transfers.filter((t) => t.status === 'transferring')).toHaveLength(70);
      expect(state.transfers.filter((t) => t.status === 'completed')).toHaveLength(60);
      expect(revoke).toHaveBeenCalledTimes(10);
    } finally { revoke.mockRestore(); client.stop(); }
  });
  it('uses injected persistence without changing or reading another client’s storage', () => {
    const createStorage = (): Storage => {
      const data = new Map<string, string>();
      return { get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null,
        getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); },
        removeItem: (key) => { data.delete(key); }, clear: () => data.clear() };
    };
    const a = createStorage(); const b = createStorage();
    a.setItem('test:pairCode', 'ABC234'); b.setItem('test:pairCode', 'XYZ567');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const first = new WarpClient({ storage: a, storagePrefix: 'test' });
    const second = new WarpClient({ storage: b, storagePrefix: 'test' });
    try {
      first.setAutoClipboardSync(false);
      expect(a.getItem('test:autoClipboard')).toBe('0');
      expect(b.getItem('test:autoClipboard')).toBeNull();
      expect(first.getSnapshot().pairCode).toBe('ABC234');
      expect(second.getSnapshot().pairCode).toBe('XYZ567');
      expect(Object.getOwnPropertyDescriptor(globalThis, 'localStorage')).toEqual(descriptor);
    } finally { first.stop(); second.stop(); }
  });

  it('bounds retained file payload memory independently of the history item count', () => {
    const { client, state } = fixture();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      const file = (name: string) => ({ name, chunks: [new Uint8Array(30)], blobUrl: `blob:${name}` });
      state.transfers = [
        { transferId: 'new', status: 'completed', receivedFiles: [file('new')] } as TransferSessionView,
        { transferId: 'old', status: 'completed', receivedFiles: [file('old')] } as TransferSessionView,
      ];
      (client as unknown as { trimBufferedHistory(budget: number): void }).trimBufferedHistory(40);
      expect(state.transfers).toHaveLength(2);
      expect(state.transfers[0].receivedFiles).toHaveLength(1);
      expect(state.transfers[1].receivedFiles).toEqual([]);
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:old');
      expect(MAX_BROWSER_BUFFERED_BYTES).toBe(128 * 1024 * 1024);
    } finally { client.stop(); revoke.mockRestore(); }
  });

  it.each([
    { name: '', size: 0 }, { name: 'bad', size: -1 }, { name: 'bad', size: 1.5 },
    { name: 'bad', size: Number.POSITIVE_INFINITY }, { name: 'x'.repeat(513), size: 1 },
    { name: 'huge', size: CHUNK_SIZE * (MAX_CHUNKS_PER_TRANSFER + 1) },
  ])('rejects invalid/unsafe outgoing manifests before encryption or file reads: %j', async (meta) => {
    const { client, state } = fixture();
    const read = vi.fn();
    state.peers = [{ peerId: 'peer' } as PeerSummary];
    try { await expect(client.sendFiles('peer', [{ ...meta, type: 'x', sliceBytes: read }])).rejects.toThrow(); expect(read).not.toHaveBeenCalled(); }
    finally { client.stop(); }
  });

});
