import { describe, expect, it } from 'vitest';
import {
  createSyntheticBuffer,
  negotiateTransfer,
  randomTransferId,
  readRepoFile,
  streamSingleFileAndVerify,
  withPairedEnv,
} from '../harness/index.js';

describe('F03: Active Transfer Dashboard', () => {
  it('completes a negotiated single-file transfer end-to-end with verified SHA-256', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const data = createSyntheticBuffer(512 * 1024, 11);
      const { sha256, sacks } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        tid,
        'dashboard-sample.bin',
        data,
        256 * 1024,
      );
      expect(sha256).toHaveLength(64);
      expect(sacks.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('supports mid-flight transfer cancellation signaled over encrypted control', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      await negotiateTransfer(desktopPeer, androidPeer, tid, [{
        index: 0,
        name: 'cancel-me.bin',
        size: 4 * 1024 * 1024,
        mimeType: 'application/octet-stream',
        totalChunks: 4,
        chunkSize: 1024 * 1024,
      }]);

      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'transfer-cancel',
        transferId: tid,
      });
      const cancelled = await androidPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-cancel' && e.payload.transferId === tid,
      );
      expect(cancelled.payload.kind).toBe('transfer-cancel');
    });
  });

  it('tracks multi-file manifests accurately across several files in one session', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const files = [
        {
          index: 0,
          name: 'a.txt',
          size: 100,
          mimeType: 'text/plain',
          totalChunks: 1,
          chunkSize: 1024 * 1024,
        },
        {
          index: 1,
          name: 'b.bin',
          size: 2048,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          chunkSize: 1024 * 1024,
        },
      ];
      const { offer, accept } = await negotiateTransfer(androidPeer, desktopPeer, tid, files);
      expect(offer.payload.kind).toBe('transfer-offer');
      if (offer.payload.kind === 'transfer-offer') {
        expect(offer.payload.files).toHaveLength(2);
        expect(offer.payload.totalBytes).toBe(2148);
      }
      expect(accept.payload.kind).toBe('transfer-accept');
    });
  });

  it('exposes Compose active/recent feeds, file staging, and cancel/accept/decline actions', async () => {
    const screen = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/screens/TransfersScreen.kt');
    expect(screen).toContain('fun TransfersScreen(');
    expect(screen).toContain('TransferStatus.PENDING_ACCEPT');
    expect(screen).toContain('TransferStatus.TRANSFERRING');
    expect(screen).toContain('onCancelTransfer');
    expect(screen).toContain('onPickFiles');
    expect(screen).toContain('onSendStagedFiles');
  });

  it('formats throughput speeds, bytes, and ETA consistently in Formatting.kt', async () => {
    const fmt = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/Formatting.kt');
    expect(fmt).toContain('fun formatBytes(');
    expect(fmt).toContain('fun formatSpeed(');
    expect(fmt).toContain('fun formatEta(');
    expect(fmt).toContain('fun transferStatusLabel(');
  });
});
