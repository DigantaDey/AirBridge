import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ControlPayload, FileManifestItem } from '../../../src/shared/protocol.js';
import {
  startTestServer,
  type ServerHandle,
  type ServerOptions,
} from './serverManager.js';
import {
  OpaquePeer,
  type BinarySackEvent,
  type DecryptedControlEvent,
  type OpaquePeerOptions,
} from './opaquePeer.js';
import { computeSha256 } from './testFixtures.js';

export const ROOT_DIR = process.cwd();

export interface PairedEnv {
  server: ServerHandle;
  androidPeer: OpaquePeer;
  desktopPeer: OpaquePeer;
  cleanup: () => Promise<void>;
}

/**
 * Provisions an ephemeral AirBridge server plus two paired OpaquePeers
 * with verified ECDH key exchange before invoking the test callback.
 */
export async function withPairedEnv(
  fn: (env: PairedEnv) => Promise<void>,
  opts: {
    serverOpts?: ServerOptions;
    androidOpts?: Partial<OpaquePeerOptions>;
    desktopOpts?: Partial<OpaquePeerOptions>;
  } = {},
): Promise<void> {
  const pairCode = opts.androidOpts?.pairCode ?? opts.desktopOpts?.pairCode ?? 'TST234';
  const server = await startTestServer({
    enableMdns: false,
    hostClipboard: false,
    ...opts.serverOpts,
  });

  const androidPeer = await OpaquePeer.create({
    name: 'Android Test',
    platform: 'android',
    formFactor: 'phone',
    pairCode,
    ...opts.androidOpts,
  });
  const desktopPeer = await OpaquePeer.create({
    name: 'Desktop Test',
    platform: 'macos',
    formFactor: 'desktop',
    pairCode,
    ...opts.desktopOpts,
  });

  const cleanup = async (): Promise<void> => {
    await androidPeer.disconnect().catch(() => {});
    await desktopPeer.disconnect().catch(() => {});
    await server.close().catch(() => {});
  };

  try {
    await Promise.all([
      androidPeer.connect(server.wsUrl),
      desktopPeer.connect(server.wsUrl),
    ]);
    await Promise.all([
      androidPeer.waitForPeer((p) => p.peerId === desktopPeer.peerId),
      desktopPeer.waitForPeer((p) => p.peerId === androidPeer.peerId),
    ]);
    await Promise.all([
      androidPeer.getSession(desktopPeer.peerId),
      desktopPeer.getSession(androidPeer.peerId),
    ]);
    await fn({ server, androidPeer, desktopPeer, cleanup });
  } finally {
    await cleanup();
  }
}

/** Runs an encrypted transfer-offer + transfer-accept handshake between two OpaquePeers. */
export async function negotiateTransfer(
  sender: OpaquePeer,
  receiver: OpaquePeer,
  transferId: string,
  files: FileManifestItem[],
  opts: { resumeFromChunks?: Record<number, number>; timeoutMs?: number } = {},
): Promise<{
  offer: DecryptedControlEvent;
  accept: DecryptedControlEvent;
}> {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  await sender.sendControl(receiver.peerId, {
    kind: 'transfer-offer',
    transferId,
    files,
    totalBytes,
    createdAt: Date.now(),
  });
  const offer = await receiver.waitForControl(
    (e) => e.payload.kind === 'transfer-offer' && e.payload.transferId === transferId,
    opts.timeoutMs ?? 5000,
  );
  await receiver.sendControl(sender.peerId, {
    kind: 'transfer-accept',
    transferId,
    preferredTransport: 'ws-relay',
    ...(opts.resumeFromChunks ? { resumeFromChunks: opts.resumeFromChunks } : {}),
  });
  const accept = await sender.waitForControl(
    (e) => e.payload.kind === 'transfer-accept' && e.payload.transferId === transferId,
    opts.timeoutMs ?? 5000,
  );
  return { offer, accept };
}

/**
 * Streams all chunks of a buffer via 0x01 over 0x02 relay, acknowledges with
 * canonical 0x03 SACKs, verifies decrypted SHA-256, and completes file/transfer controls.
 */
export async function streamSingleFileAndVerify(
  sender: OpaquePeer,
  receiver: OpaquePeer,
  transferId: string,
  fileName: string,
  data: Uint8Array,
  chunkSize = 1024 * 1024,
  startChunk = 0,
): Promise<{ sha256: string; sacks: BinarySackEvent[] }> {
  const totalChunks = Math.max(1, Math.ceil(data.byteLength / chunkSize));
  const chunks = data.byteLength === 0
    ? [new Uint8Array(0)]
    : createSyntheticChunksFromBuffer(data, chunkSize);

  const manifest: FileManifestItem[] = [{
    index: 0,
    name: fileName,
    size: data.byteLength,
    mimeType: 'application/octet-stream',
    totalChunks,
    chunkSize,
  }];

  await negotiateTransfer(sender, receiver, transferId, manifest, {
    resumeFromChunks: startChunk > 0 ? { 0: startChunk } : undefined,
  });

  const reassembled = new Uint8Array(data.byteLength);
  if (startChunk > 0 && data.byteLength > 0) {
    const prefixEnd = Math.min(data.byteLength, startChunk * chunkSize);
    reassembled.set(data.subarray(0, prefixEnd), 0);
  }

  const sacks: BinarySackEvent[] = [];
  for (let i = startChunk; i < chunks.length; i++) {
    await sender.sendChunk(receiver.peerId, transferId, 0, i, chunks[i]);
    const evt = await receiver.waitForChunk(
      (c) => c.frame.transferId === transferId && c.frame.fileIndex === 0 && c.frame.chunkIndex === i,
      8000,
    );
    if (evt.plaintext.byteLength > 0) {
      reassembled.set(evt.plaintext, i * chunkSize);
    }
    if ((i + 1) % 2 === 0 || i === chunks.length - 1) {
      await receiver.sendCanonicalBinarySack(sender.peerId, transferId, 0, i, 0);
      const sack = await sender.waitForSack(
        (s) => s.canonical?.transferId === transferId && s.canonical.chunkIndex === i,
        5000,
      );
      sacks.push(sack);
    }
  }

  const expectedSha = await computeSha256(data);
  const actualSha = await computeSha256(reassembled);
  if (actualSha !== expectedSha) {
    throw new Error(`Reassembled SHA-256 mismatch: ${actualSha} !== ${expectedSha}`);
  }

  const completePayload: ControlPayload = {
    kind: 'file-complete',
    transferId,
    fileIndex: 0,
    sha256: expectedSha,
  };
  await sender.sendControl(receiver.peerId, completePayload);
  await receiver.waitForControl(
    (e) => e.payload.kind === 'file-complete' && e.payload.transferId === transferId,
  );
  await sender.sendControl(receiver.peerId, { kind: 'transfer-complete', transferId });
  await receiver.waitForControl(
    (e) => e.payload.kind === 'transfer-complete' && e.payload.transferId === transferId,
  );
  await receiver.sendControl(sender.peerId, {
    kind: 'transfer-complete-ack',
    transferId,
    verified: true,
  });
  await sender.waitForControl(
    (e) => e.payload.kind === 'transfer-complete-ack' && e.payload.transferId === transferId,
  );

  return { sha256: expectedSha, sacks };
}

function createSyntheticChunksFromBuffer(buf: Uint8Array, chunkSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < buf.byteLength; off += chunkSize) {
    out.push(buf.subarray(off, Math.min(buf.byteLength, off + chunkSize)));
  }
  return out;
}

export async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(ROOT_DIR, relativePath), 'utf8');
}

export async function repoFileExists(relativePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(ROOT_DIR, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function randomTransferId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
