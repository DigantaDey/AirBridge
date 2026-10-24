import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MacDaemonConfig } from './macIntegration.js';
import { resolveFinalPath, triggerMacNotification } from './macIntegration.js';

/**
 * Received-chunk bookkeeping for the disk-backed receive path.
 *
 * The browser decrypts each inbound chunk and posts it here over loopback;
 * this store writes it straight to a `.part` file at its declared offset,
 * so a multi-gigabyte transfer never lives entirely in browser memory. The
 * manifest is persisted next to the temp file, which makes an interrupted
 * transfer recoverable: a later accept can query what already landed and
 * resume from there instead of starting over.
 */

export interface PartialReceiveMeta {
  transferId: string;
  fileIndex: number;
  name: string;
  senderName?: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
}

export interface PartialReceiveState extends PartialReceiveMeta {
  tempPath: string;
  metaPath: string;
  receivedChunks: boolean[];
  receivedCount: number;
  receivedBytes: number;
  fd?: fs.promises.FileHandle;
}

export interface FinalizeResult {
  savedPath: string;
  finalName: string;
  sha256: string;
  bytes: number;
}

export interface ReceivedSummary {
  transferId: string;
  fileIndex: number;
  name: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  receivedCount: number;
  receivedBytes: number;
  complete: boolean;
  /** Indices of chunks already on disk, ascending. */
  receivedChunks: number[];
}

const TRANSFER_ID_RE = /^[0-9a-f]{16}$/;

function isValidMeta(meta: PartialReceiveMeta): boolean {
  return (
    TRANSFER_ID_RE.test(meta.transferId) &&
    Number.isInteger(meta.fileIndex) &&
    meta.fileIndex >= 0 &&
    typeof meta.name === 'string' &&
    meta.name.length > 0 &&
    Number.isFinite(meta.size) &&
    meta.size >= 0 &&
    Number.isFinite(meta.chunkSize) &&
    meta.chunkSize > 0 &&
    Number.isInteger(meta.totalChunks) &&
    meta.totalChunks >= 1
  );
}

export class PartialReceiveStore {
  private readonly states = new Map<string, PartialReceiveState>();
  // Serialises chunk writes per file so concurrent requests cannot interleave
  // on the shared file descriptor.
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly config: MacDaemonConfig) {}

  private get partialDir(): string {
    return path.join(this.config.downloadDir, '.airbridge-partial');
  }

  private key(transferId: string, fileIndex: number): string {
    return `${transferId}:${fileIndex}`;
  }

  private pathsFor(transferId: string, fileIndex: number): { tempPath: string; metaPath: string } {
    return {
      tempPath: path.join(this.partialDir, `${transferId}-${fileIndex}.part`),
      metaPath: path.join(this.partialDir, `${transferId}-${fileIndex}.json`),
    };
  }

  private async serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(
      () => fn(),
      () => fn(),
    );
    // The stored chain must never reject, otherwise one failed write would
    // poison every later write to the same file.
    this.chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Load a persisted manifest, or create a fresh state. Idempotent. */
  async ensure(meta: PartialReceiveMeta): Promise<PartialReceiveState> {
    if (!isValidMeta(meta)) {
      throw new Error('Invalid receive manifest.');
    }
    const key = this.key(meta.transferId, meta.fileIndex);
    const existing = this.states.get(key);
    if (existing) return existing;

    const { tempPath, metaPath } = this.pathsFor(meta.transferId, meta.fileIndex);
    await fs.promises.mkdir(this.partialDir, { recursive: true });

    let receivedChunks: boolean[] = new Array(meta.totalChunks).fill(false);
    let receivedCount = 0;
    let receivedBytes = 0;
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        receivedChunks?: unknown;
        receivedBytes?: unknown;
        size?: unknown;
        chunkSize?: unknown;
        totalChunks?: unknown;
        name?: unknown;
        senderName?: unknown;
      };
      // Only trust a manifest whose declared dimensions match the current
      // offer; a stale file from a previous, differently-sized transfer must
      // not be mistaken for a partial of this one.
      if (
        Number(parsed.size) === meta.size &&
        Number(parsed.chunkSize) === meta.chunkSize &&
        Number(parsed.totalChunks) === meta.totalChunks &&
        typeof parsed.name === 'string'
      ) {
        const arr = parsed.receivedChunks;
        if (Array.isArray(arr)) {
          receivedChunks = new Array(meta.totalChunks).fill(false);
          for (let i = 0; i < arr.length && i < meta.totalChunks; i++) {
            if (arr[i]) {
              receivedChunks[i] = true;
              receivedCount++;
            }
          }
        }
        receivedBytes = Number(parsed.receivedBytes) || 0;
      }
    } catch {
      // Fresh receive: no persisted manifest yet.
    }

    const state: PartialReceiveState = {
      ...meta,
      tempPath,
      metaPath,
      receivedChunks,
      receivedCount,
      receivedBytes,
    };
    this.states.set(key, state);
    return state;
  }

  private async getOrRecover(transferId: string, fileIndex: number): Promise<PartialReceiveState | null> {
    const key = this.key(transferId, fileIndex);
    const inMemory = this.states.get(key);
    if (inMemory) return inMemory;
    const { tempPath, metaPath } = this.pathsFor(transferId, fileIndex);
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as PartialReceiveState;
      if (
        parsed &&
        TRANSFER_ID_RE.test(parsed.transferId || '') &&
        Number.isInteger(parsed.fileIndex) &&
        Array.isArray(parsed.receivedChunks)
      ) {
        const state: PartialReceiveState = {
          transferId,
          fileIndex,
          name: String(parsed.name || 'file'),
          senderName: typeof parsed.senderName === 'string' ? parsed.senderName : undefined,
          size: Number(parsed.size) || 0,
          chunkSize: Number(parsed.chunkSize) || 0,
          totalChunks: Number(parsed.totalChunks) || 0,
          tempPath,
          metaPath,
          receivedChunks: parsed.receivedChunks,
          receivedCount: parsed.receivedChunks.filter(Boolean).length,
          receivedBytes: Number(parsed.receivedBytes) || 0,
        };
        this.states.set(key, state);
        return state;
      }
    } catch {
      // no persisted manifest
    }
    return null;
  }

  private async ensureFd(state: PartialReceiveState): Promise<fs.promises.FileHandle> {
    if (state.fd) return state.fd;
    const flag = await fs.promises
      .access(state.tempPath)
      .then(() => 'r+')
      .catch(() => 'w+');
    state.fd = await fs.promises.open(state.tempPath, flag);
    return state.fd;
  }

  private async closeFd(state: PartialReceiveState): Promise<void> {
    if (state.fd) {
      await state.fd.close().catch(() => {});
    }
    state.fd = undefined;
  }

  private async persist(state: PartialReceiveState): Promise<void> {
    const payload = {
      transferId: state.transferId,
      fileIndex: state.fileIndex,
      name: state.name,
      senderName: state.senderName,
      size: state.size,
      chunkSize: state.chunkSize,
      totalChunks: state.totalChunks,
      receivedChunks: state.receivedChunks,
      receivedBytes: state.receivedBytes,
    };
    const tmp = `${state.metaPath}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
    await fs.promises.rename(tmp, state.metaPath);
  }

  async writeChunk(meta: PartialReceiveMeta, chunkIndex: number, data: Uint8Array): Promise<void> {
    const key = this.key(meta.transferId, meta.fileIndex);
    await this.serialized(key, async () => {
      const state = await this.ensure(meta);
      if (chunkIndex < 0 || chunkIndex >= state.totalChunks) {
        throw new Error('Chunk index out of range.');
      }
      if (state.receivedChunks[chunkIndex]) return; // idempotent re-delivery
      const expected =
        state.size === 0 ? 0 : Math.min(state.chunkSize, state.size - chunkIndex * state.chunkSize);
      if (data.byteLength !== expected) {
        throw new Error('Chunk byte length does not match the declared manifest.');
      }
      const fd = await this.ensureFd(state);
      await fd.write(data, 0, data.byteLength, chunkIndex * state.chunkSize);
      state.receivedChunks[chunkIndex] = true;
      state.receivedCount++;
      state.receivedBytes += data.byteLength;
      await this.persist(state);
    });
  }

  async listReceived(transferId: string, fileIndex: number): Promise<ReceivedSummary | null> {
    if (!TRANSFER_ID_RE.test(transferId) || !Number.isInteger(fileIndex) || fileIndex < 0) {
      return null;
    }
    const state = await this.getOrRecover(transferId, fileIndex);
    if (!state) return null;
    const receivedChunks: number[] = [];
    for (let i = 0; i < state.receivedChunks.length; i++) {
      if (state.receivedChunks[i]) receivedChunks.push(i);
    }
    return {
      transferId: state.transferId,
      fileIndex: state.fileIndex,
      name: state.name,
      size: state.size,
      chunkSize: state.chunkSize,
      totalChunks: state.totalChunks,
      receivedCount: state.receivedCount,
      receivedBytes: state.receivedBytes,
      complete: state.receivedCount === state.totalChunks,
      receivedChunks,
    };
  }

  private async hashFile(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk: Buffer | string) => {
        hash.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    return hash.digest('hex');
  }

  async finalize(transferId: string, fileIndex: number): Promise<FinalizeResult> {
    if (!TRANSFER_ID_RE.test(transferId) || !Number.isInteger(fileIndex) || fileIndex < 0) {
      throw new Error('Invalid finalize request.');
    }
    const key = this.key(transferId, fileIndex);
    return this.serialized(key, async () => {
      const state = await this.getOrRecover(transferId, fileIndex);
      if (!state) throw new Error('No in-progress receive for this file.');
      await fs.promises.mkdir(this.config.downloadDir, { recursive: true });
      await this.closeFd(state);
      if (state.receivedCount !== state.totalChunks) {
        throw new Error('File is incomplete: chunks are still missing.');
      }
      if (state.receivedBytes !== state.size) {
        throw new Error('Received byte count does not match the declared file size.');
      }
      const sha256 = await this.hashFile(state.tempPath);
      const finalPath = await resolveFinalPath(this.config.downloadDir, state.name);
      await fs.promises.rename(state.tempPath, finalPath);
      await fs.promises.rm(state.metaPath, { force: true });
      this.states.delete(key);

      if (process.platform === 'darwin' && this.config.notifyOnReceive) {
        triggerMacNotification(
          'AirBridge — File Received',
          `${path.basename(finalPath)}${state.senderName ? ` from ${state.senderName}` : ''} saved to ${this.config.downloadDir}`,
        );
      }
      return {
        savedPath: finalPath,
        finalName: path.basename(finalPath),
        sha256,
        bytes: state.size,
      };
    });
  }

  async discard(transferId: string, fileIndex: number): Promise<void> {
    if (!TRANSFER_ID_RE.test(transferId) || !Number.isInteger(fileIndex) || fileIndex < 0) return;
    const key = this.key(transferId, fileIndex);
    await this.serialized(key, async () => {
      const state = await this.getOrRecover(transferId, fileIndex);
      if (!state) return;
      await this.closeFd(state);
      await fs.promises.rm(state.tempPath, { force: true });
      await fs.promises.rm(state.metaPath, { force: true });
      this.states.delete(key);
    });
  }

  /** Close any open file handles (called when the server shuts down). */
  async dispose(): Promise<void> {
    for (const state of this.states.values()) {
      await this.closeFd(state);
    }
    this.states.clear();
  }
}
