import { describe, expect, it, vi } from 'vitest';
import { WarpClient, type ClipboardBeamItem, type TransferSessionView } from '../src/client/engine/warpClient.js';
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
});
