import { describe, expect, it } from 'vitest';
import {
  isValidSasCode,
  negotiateTransfer,
  randomTransferId,
  readRepoFile,
  withPairedEnv,
} from '../harness/index.js';

describe('F04: Incoming Transfer Offer Modal', () => {
  it('derives identical 6-digit SAS verification codes on both peers', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const sasAndroid = await androidPeer.getSasCode(desktopPeer.peerId);
      const sasDesktop = await desktopPeer.getSasCode(androidPeer.peerId);
      expect(sasAndroid).toBe(sasDesktop);
      expect(isValidSasCode(sasAndroid)).toBe(true);
    });
  });

  it('delivers encrypted transfer-offer payload and allows explicit acceptance', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const { offer, accept } = await negotiateTransfer(desktopPeer, androidPeer, tid, [{
        index: 0,
        name: 'report.pdf',
        size: 16_384,
        mimeType: 'application/pdf',
        totalChunks: 1,
        chunkSize: 1024 * 1024,
      }]);
      expect(offer.payload.kind).toBe('transfer-offer');
      expect(accept.payload.kind).toBe('transfer-accept');
    });
  });

  it('transmits encrypted transfer-decline when receiver rejects an offer', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'transfer-offer',
        transferId: tid,
        files: [{
          index: 0,
          name: 'unwanted.bin',
          size: 4096,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          chunkSize: 1024 * 1024,
        }],
        totalBytes: 4096,
        createdAt: Date.now(),
      });
      await androidPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-offer' && e.payload.transferId === tid,
      );
      await androidPeer.sendControl(desktopPeer.peerId, {
        kind: 'transfer-decline',
        transferId: tid,
      });
      const declined = await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-decline' && e.payload.transferId === tid,
      );
      expect(declined.payload.kind).toBe('transfer-decline');
    });
  });

  it('carries visual preview thumbnails cleanly inside incoming offers', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const preview = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
      const { offer } = await negotiateTransfer(desktopPeer, androidPeer, tid, [{
        index: 0,
        name: 'thumb.png',
        size: 128,
        mimeType: 'image/png',
        totalChunks: 1,
        chunkSize: 1024 * 1024,
        previewDataUrl: preview,
      }]);
      expect(offer.payload.kind).toBe('transfer-offer');
      if (offer.payload.kind === 'transfer-offer') {
        expect(offer.payload.files[0].previewDataUrl).toBe(preview);
      }
    });
  });

  it('implements AlertDialog confirmation and trust-device checkbox in TransferOfferDialog.kt', async () => {
    const dialog = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/components/TransferOfferDialog.kt');
    expect(dialog).toContain('fun TransferOfferDialog(');
    expect(dialog).toContain('AlertDialog(');
    expect(dialog).toContain('sasCode');
    expect(dialog).toContain('trustSender');

    const app = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt');
    expect(app).toContain('onAcceptOfferWithTrust');
    expect(app).toContain('viewModel.setTrusted(senderKey, true)');
  });
});
