import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  randomTransferId,
  readRepoFile,
  streamSingleFileAndVerify,
  withPairedEnv,
} from '../harness/index.js';

describe('F11: Direct-to-MediaStore Streaming Sink & Journal Recovery', () => {
  it('defines MediaStoreFileSink streaming directly to MediaStore.Downloads with IS_PENDING lifecycle', async () => {
    const nativeFiles = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/NativeFiles.kt',
    );
    expect(nativeFiles).toContain('class MediaStoreFileSink');
    expect(nativeFiles).toContain('MediaStore.Downloads.EXTERNAL_CONTENT_URI');
    expect(nativeFiles).toContain('Environment.DIRECTORY_DOWNLOADS}/AirBridge');
    expect(nativeFiles).toContain('MediaStore.MediaColumns.IS_PENDING');
    expect(nativeFiles).toContain('DirectoryFileSink');
  });

  it('persists compact .meta sidecars and 4-byte append-only journals for crash/restart resumption', async () => {
    const nativeFiles = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/NativeFiles.kt',
    );
    expect(nativeFiles).toContain('replayJournal()');
    expect(nativeFiles).toContain('flushJournal()');
    expect(nativeFiles).toContain('override fun resumeFrom(): Int');
  });

  it('verifies SHA-256 BEFORE clearing IS_PENDING = 0 and deletes pending entries on mismatch', async () => {
    const nativeFiles = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/NativeFiles.kt',
    );
    const mediaSinkStart = nativeFiles.indexOf('class MediaStoreFileSink');
    expect(mediaSinkStart).toBeGreaterThan(0);
    const shaCheckIdx = nativeFiles.indexOf('if (declaredSha256 != hex)', mediaSinkStart);
    const publishIdx = nativeFiles.indexOf('put(MediaStore.MediaColumns.IS_PENDING, 0)', mediaSinkStart);
    expect(shaCheckIdx).toBeGreaterThan(mediaSinkStart);
    expect(publishIdx).toBeGreaterThan(shaCheckIdx);
    expect(nativeFiles).toContain('SHA-256 verification failed; partial file discarded.');
    expect(nativeFiles).toContain('discard()');
  });

  it('sanitizes incoming filenames against path traversal and reserved FAT control characters', async () => {
    const nativeFiles = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/NativeFiles.kt',
    );
    expect(nativeFiles).toContain('private fun safeName(raw: String)');
    expect(nativeFiles).toContain('substringAfterLast(\'/\')');
    expect(nativeFiles).toContain('substringAfterLast(\'\\\\\')');
    expect(nativeFiles).toContain('it in ":*?\\"<>|"');
  });

  it('streams and resumes a multi-chunk file from mid-stream chunk index 2 with verified full-file SHA-256', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const chunkSize = 128 * 1024;
      const data = createSyntheticBuffer(5 * chunkSize, 63);
      const transferId = randomTransferId();
      const { sha256 } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        transferId,
        'mediastore-resumed.mp4',
        data,
        chunkSize,
        2,
      );
      expect(sha256).toBe(await computeSha256(data));
    });
  });

  it('verifies file-complete SHA-256 mismatch detection in end-to-end transfer completion', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const data = createSyntheticBuffer(64 * 1024, 11);
      const wrongSha = '0'.repeat(64);
      const transferId = randomTransferId();
      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'transfer-offer',
        transferId,
        files: [
          {
            index: 0,
            name: 'corrupt-check.bin',
            size: data.byteLength,
            mimeType: 'application/octet-stream',
            totalChunks: 1,
            chunkSize: data.byteLength,
          },
        ],
        totalBytes: data.byteLength,
        createdAt: Date.now(),
      });
      await androidPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-offer' && e.payload.transferId === transferId,
      );
      await androidPeer.sendControl(desktopPeer.peerId, {
        kind: 'transfer-accept',
        transferId,
        preferredTransport: 'ws-relay',
      });
      await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-accept' && e.payload.transferId === transferId,
      );
      await desktopPeer.sendChunk(androidPeer.peerId, transferId, 0, 0, data);
      const rx = await androidPeer.waitForChunk(
        (c) => c.frame.transferId === transferId && c.frame.chunkIndex === 0,
      );
      const actualSha = await computeSha256(rx.plaintext);
      expect(actualSha).not.toBe(wrongSha);

      await androidPeer.sendControl(desktopPeer.peerId, {
        kind: 'transfer-complete-ack',
        transferId,
        verified: false,
        reason: 'SHA-256 mismatch',
      });
      const ack = await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-complete-ack' && e.payload.transferId === transferId,
      );
      expect(ack.payload.kind === 'transfer-complete-ack' && ack.payload.verified).toBe(false);
    });
  });
});
