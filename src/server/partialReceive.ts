import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MacDaemonConfig } from './macIntegration.js';
import { publishReceivedFile, triggerMacNotification } from './macIntegration.js';

/**
 * Received-chunk bookkeeping for the disk-backed receive path.
 *
 * The browser decrypts each inbound chunk and posts it here over loopback;
 * this store writes it straight to a `.part` file at its declared offset,
 * so a multi-gigabyte transfer never lives entirely in browser memory. One
 * atomic manifest plus an append-only chunk journal is persisted next to the
 * temp file, which makes an interrupted transfer recoverable without rewriting
 * growing JSON metadata for every chunk: a later accept can query what already
 * landed and resume from there instead of starting over.
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
  /** Append-only, fixed-width chunk journal (four-byte big-endian indexes). */
  journalPath: string;
  receivedChunks: boolean[];
  receivedCount: number;
  receivedBytes: number;
  /** Indexes not yet appended to the journal. Losing these only causes a safe re-send. */
  pendingJournal: number[];
  hasSnapshot: boolean;
  runningHash?: crypto.Hash | null;
  hashedContiguousChunks?: number;
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
const JOURNAL_ENTRY_BYTES = 4;
// A checkpoint per 8 MiB (at the default chunk size) bounds both metadata I/O
// and the amount that may need to be re-sent after a process crash. The final
// chunk of every file is always checkpointed.
const JOURNAL_FLUSH_CHUNKS = 32;
export const DEFAULT_PARTIAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface PartialReceiveStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

function isValidMeta(meta: PartialReceiveMeta): boolean {
  return (
    TRANSFER_ID_RE.test(meta.transferId) &&
    Number.isSafeInteger(meta.fileIndex) &&
    meta.fileIndex >= 0 && meta.fileIndex < 100 &&
    typeof meta.name === 'string' &&
    meta.name.length > 0 && meta.name.length <= 512 &&
    Number.isSafeInteger(meta.size) &&
    meta.size >= 0 &&
    Number.isSafeInteger(meta.chunkSize) &&
    meta.chunkSize > 0 && meta.chunkSize <= 1024 * 1024 &&
    Number.isInteger(meta.totalChunks) &&
    meta.totalChunks >= 1 && meta.totalChunks <= 262_144 &&
    meta.totalChunks === Math.max(1, Math.ceil(meta.size / meta.chunkSize))
  );
}

export class PartialReceiveStore {
  private readonly states = new Map<string, PartialReceiveState>();
  // Serialises chunk writes per file so concurrent requests cannot interleave
  // on the shared file descriptor.
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private orphanedPartialsCleaned = 0;
  private finalizeCount = 0;
  private finalizeRehashCount = 0;
  private lastFinalizeDurationMs: number | null = null;

  constructor(private readonly config: MacDaemonConfig, opts: PartialReceiveStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PARTIAL_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  public getStats(): {
    activePartials: number;
    orphanedPartialsCleaned: number;
    finalizeCount: number;
    finalizeRehashCount: number;
    lastFinalizeDurationMs: number | null;
  } {
    return {
      activePartials: this.states.size,
      orphanedPartialsCleaned: this.orphanedPartialsCleaned,
      finalizeCount: this.finalizeCount,
      finalizeRehashCount: this.finalizeRehashCount,
      lastFinalizeDurationMs: this.lastFinalizeDurationMs,
    };
  }

  /**
   * Sweep `.airbridge-partial/` and remove expired `.part`/`.json`/`.journal`/`.tmp`
   * entries older than `maxAgeMs` (default 24h) that are not currently active in memory.
   */
  public async cleanupExpiredPartials(maxAgeMs = this.ttlMs): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.partialDir);
    } catch {
      return 0;
    }
    const cutoff = this.now() - maxAgeMs;
    const prefixGroups = new Map<string, { files: string[]; newestMtime: number }>();
    for (const entry of entries) {
      const m = /^([0-9a-f]{16}-\d+)\.(part|json|journal)(?:\..*\.tmp|\.tmp)?$/.exec(entry);
      const groupKey = m ? m[1]! : entry;
      const fullPath = path.join(this.partialDir, entry);
      const st = await fs.promises.stat(fullPath).catch(() => null);
      if (!st) continue;
      const g = prefixGroups.get(groupKey) ?? { files: [], newestMtime: 0 };
      g.files.push(fullPath);
      if (st.mtimeMs > g.newestMtime) g.newestMtime = st.mtimeMs;
      prefixGroups.set(groupKey, g);
    }

    let cleaned = 0;
    for (const [groupKey, group] of prefixGroups.entries()) {
      const stateKey = groupKey.replace('-', ':');
      if (this.states.has(stateKey)) continue;
      if (group.newestMtime <= cutoff) {
        for (const f of group.files) {
          await fs.promises.rm(f, { force: true }).catch(() => {});
        }
        cleaned++;
      }
    }
    this.orphanedPartialsCleaned += cleaned;
    return cleaned;
  }

  private get partialDir(): string {
    return path.join(this.config.downloadDir, '.airbridge-partial');
  }

  private key(transferId: string, fileIndex: number): string {
    return `${transferId}:${fileIndex}`;
  }

  private pathsFor(
    transferId: string,
    fileIndex: number,
  ): { tempPath: string; metaPath: string; journalPath: string } {
    return {
      tempPath: path.join(this.partialDir, `${transferId}-${fileIndex}.part`),
      metaPath: path.join(this.partialDir, `${transferId}-${fileIndex}.json`),
      journalPath: path.join(this.partialDir, `${transferId}-${fileIndex}.journal`),
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
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(key, tail);
    // Completed per-file promises used to accumulate for the daemon's entire
    // lifetime. Only remove our own tail; a later queued write still owns it.
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return run;
  }

  /** Load a persisted manifest, or create a fresh state. Idempotent. */
  async ensure(meta: PartialReceiveMeta): Promise<PartialReceiveState> {
    if (!isValidMeta(meta)) {
      throw new Error('Invalid receive manifest.');
    }
    const key = this.key(meta.transferId, meta.fileIndex);
    const matchesManifest = (candidate: PartialReceiveMeta): boolean =>
      candidate.transferId === meta.transferId &&
      candidate.fileIndex === meta.fileIndex &&
      candidate.name === meta.name &&
      candidate.size === meta.size &&
      candidate.chunkSize === meta.chunkSize &&
      candidate.totalChunks === meta.totalChunks;
    const existing = this.states.get(key);
    if (existing) {
      if (!matchesManifest(existing)) {
        throw new Error('Transfer ID already exists with a different receive manifest.');
      }
      return existing;
    }

    const { tempPath, metaPath, journalPath } = this.pathsFor(meta.transferId, meta.fileIndex);
    await fs.promises.mkdir(this.partialDir, { recursive: true });

    const receivedChunks: boolean[] = new Array(meta.totalChunks).fill(false);
    let receivedCount = 0;
    let hasSnapshot = false;
    let parsedManifest:
      | {
          transferId?: unknown;
          fileIndex?: unknown;
          receivedChunks?: unknown;
          size?: unknown;
          chunkSize?: unknown;
          totalChunks?: unknown;
          name?: unknown;
        }
      | undefined;
    try {
      parsedManifest = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as typeof parsedManifest;
    } catch {
      // Fresh receive: no persisted manifest yet, or an unreadable old manifest.
    }
    if (parsedManifest) {
      const matchesPersistedManifest =
        parsedManifest.transferId === meta.transferId &&
        parsedManifest.fileIndex === meta.fileIndex &&
        parsedManifest.size === meta.size &&
        parsedManifest.chunkSize === meta.chunkSize &&
        parsedManifest.totalChunks === meta.totalChunks &&
        parsedManifest.name === meta.name;
      if (!matchesPersistedManifest) {
        throw new Error('Transfer ID already exists with a different persisted receive manifest.');
      }
      const arr = parsedManifest.receivedChunks;
      if (!Array.isArray(arr)) {
        throw new Error('Persisted receive manifest is invalid.');
      }
      for (let i = 0; i < arr.length && i < meta.totalChunks; i++) {
        if (arr[i]) {
          receivedChunks[i] = true;
          receivedCount++;
        }
      }
      hasSnapshot = true;
    }

    const state: PartialReceiveState = {
      ...meta,
      tempPath,
      metaPath,
      journalPath,
      receivedChunks,
      receivedCount,
      receivedBytes: 0,
      pendingJournal: [],
      hasSnapshot,
      runningHash: hasSnapshot ? null : crypto.createHash('sha256'),
      hashedContiguousChunks: 0,
    };
    if (hasSnapshot) {
      await this.replayJournal(state);
    } else {
      // An orphaned journal has no trustworthy dimensions without its manifest.
      await fs.promises.rm(journalPath, { force: true });
    }
    if (hasSnapshot) {
      const part = await fs.promises.stat(tempPath).catch(() => null);
      if (!part?.isFile() || part.size !== meta.size) {
        // A ledger without its exact-sized .part is not a valid resume hint.
        state.receivedChunks.fill(false);
        state.receivedCount = 0;
        state.hasSnapshot = false;
        state.runningHash = crypto.createHash('sha256');
        state.hashedContiguousChunks = 0;
        await fs.promises.rm(journalPath, { force: true });
        await fs.promises.rm(metaPath, { force: true });
      }
    }
    this.recountReceivedBytes(state);
    this.states.set(key, state);
    return state;
  }

  private async getOrRecover(transferId: string, fileIndex: number): Promise<PartialReceiveState | null> {
    const key = this.key(transferId, fileIndex);
    const inMemory = this.states.get(key);
    if (inMemory) return inMemory;
    const { tempPath, metaPath, journalPath } = this.pathsFor(transferId, fileIndex);
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as PartialReceiveState;
      if (
        parsed && isValidMeta(parsed) &&
        parsed.transferId === transferId && parsed.fileIndex === fileIndex &&
        TRANSFER_ID_RE.test(parsed.transferId || '') &&
        Number.isInteger(parsed.fileIndex) &&
        Array.isArray(parsed.receivedChunks) &&
        Number.isInteger(parsed.totalChunks) &&
        parsed.totalChunks > 0 &&
        Number.isInteger(parsed.chunkSize) &&
        parsed.chunkSize > 0 &&
        Number.isInteger(parsed.size) &&
        parsed.size >= 0
      ) {
        const part = await fs.promises.stat(tempPath).catch(() => null);
        if (!part?.isFile() || part.size !== parsed.size) return null;
        const receivedChunks = new Array<boolean>(parsed.totalChunks).fill(false);
        for (let i = 0; i < parsed.totalChunks; i++) receivedChunks[i] = parsed.receivedChunks[i] === true;
        const state: PartialReceiveState = {
          transferId,
          fileIndex,
          name: String(parsed.name || 'file'),
          senderName: typeof parsed.senderName === 'string' ? parsed.senderName : undefined,
          size: Number(parsed.size) || 0,
          chunkSize: Number(parsed.chunkSize) || 0,
          totalChunks: Number(parsed.totalChunks),
          tempPath,
          metaPath,
          journalPath,
          receivedChunks,
          receivedCount: receivedChunks.filter(Boolean).length,
          receivedBytes: 0,
          pendingJournal: [],
          hasSnapshot: true,
        };
        await this.replayJournal(state);
        this.recountReceivedBytes(state);
        this.states.set(key, state);
        return state;
      }
    } catch {
      // no persisted manifest
    }
    return null;
  }

  private recountReceivedBytes(state: PartialReceiveState): void {
    let bytes = 0;
    for (let i = 0; i < state.totalChunks; i++) {
      if (!state.receivedChunks[i]) continue;
      bytes += state.size === 0 ? 0 : Math.min(state.chunkSize, state.size - i * state.chunkSize);
    }
    state.receivedBytes = bytes;
  }

  /** Replay complete journal entries; a crash-truncated tail is discarded safely. */
  private async replayJournal(state: PartialReceiveState): Promise<void> {
    try {
      const journal = await fs.promises.readFile(state.journalPath);
      const completeLength = journal.byteLength - (journal.byteLength % JOURNAL_ENTRY_BYTES);
      if (completeLength !== journal.byteLength) {
        await fs.promises.truncate(state.journalPath, completeLength);
      }
      for (let offset = 0; offset < completeLength; offset += JOURNAL_ENTRY_BYTES) {
        const chunkIndex = journal.readUInt32BE(offset);
        if (chunkIndex < state.totalChunks && !state.receivedChunks[chunkIndex]) {
          state.receivedChunks[chunkIndex] = true;
          state.receivedCount++;
        }
      }
    } catch {
      // No journal (or an unreadable one): the atomic snapshot remains valid.
    }
  }

  private async ensureFd(state: PartialReceiveState): Promise<fs.promises.FileHandle> {
    if (state.fd) return state.fd;
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(state.tempPath, 'r+');
    } catch {
      fh = await fs.promises.open(state.tempPath, 'w+');
    }
    state.fd = fh;
    // Only truncate when initializing or resizing when the on-disk size differs
    // from the declared size (avoiding redundant ftruncate on every open).
    const st = await fh.stat();
    if (st.size !== state.size) {
      await fh.truncate(state.size);
    }
    return state.fd;
  }

  private async closeFd(state: PartialReceiveState): Promise<void> {
    if (state.fd) {
      await state.fd.close().catch(() => {});
    }
    state.fd = undefined;
  }

  private async persist(
    state: PartialReceiveState,
    overrides?: { receivedChunks: boolean[]; receivedBytes: number },
  ): Promise<void> {
    const payload = {
      transferId: state.transferId,
      fileIndex: state.fileIndex,
      name: state.name,
      senderName: state.senderName,
      size: state.size,
      chunkSize: state.chunkSize,
      totalChunks: state.totalChunks,
      receivedChunks: overrides ? overrides.receivedChunks : state.receivedChunks,
      receivedBytes: overrides ? overrides.receivedBytes : state.receivedBytes,
    };
    const tmp = `${state.metaPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
    await fs.promises.rename(tmp, state.metaPath);
    state.hasSnapshot = true;
  }

  /** Append a batch in O(number of new chunks), never rewriting prior history. */
  private async flushJournal(state: PartialReceiveState, extraChunkIndex?: number): Promise<void> {
    const entries = extraChunkIndex !== undefined
      ? [...state.pendingJournal, extraChunkIndex]
      : state.pendingJournal;
    if (entries.length === 0) return;
    // If a previous append was interrupted, discard its partial entry before
    // adding more so every later index stays four-byte aligned.
    const stat = await fs.promises.stat(state.journalPath).catch(() => null);
    if (stat && stat.size % JOURNAL_ENTRY_BYTES !== 0) {
      await fs.promises.truncate(
        state.journalPath,
        stat.size - (stat.size % JOURNAL_ENTRY_BYTES),
      );
    }
    const batch = Buffer.allocUnsafe(entries.length * JOURNAL_ENTRY_BYTES);
    for (let i = 0; i < entries.length; i++) {
      batch.writeUInt32BE(entries[i]!, i * JOURNAL_ENTRY_BYTES);
    }
    await fs.promises.appendFile(state.journalPath, batch, { mode: 0o600 });
    state.pendingJournal = [];
  }

  async writeChunk(meta: PartialReceiveMeta, chunkIndex: number, data: Uint8Array): Promise<void> {
    const key = this.key(meta.transferId, meta.fileIndex);
    await this.serialized(key, async () => {
      const state = await this.ensure(meta);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= state.totalChunks) {
        throw new Error('Chunk index out of range.');
      }
      if (state.receivedChunks[chunkIndex]) return; // idempotent re-delivery
      const expected =
        state.size === 0 ? 0 : Math.min(state.chunkSize, state.size - chunkIndex * state.chunkSize);
      if (data.byteLength !== expected) {
        throw new Error('Chunk byte length does not match the declared manifest.');
      }
      const fd = await this.ensureFd(state);
      let written = 0;
      while (written < data.byteLength) {
        const result = await fd.write(data, written, data.byteLength - written, chunkIndex * state.chunkSize + written);
        if (result.bytesWritten <= 0) throw new Error('Disk write made no progress.');
        written += result.bytesWritten;
      }

      if (!state.hasSnapshot) {
        // One small atomic manifest per file anchors the append-only journal
        // and preserves compatibility with existing .json partial receives.
        const nextChunks = state.receivedChunks.slice();
        nextChunks[chunkIndex] = true;
        await this.persist(state, {
          receivedChunks: nextChunks,
          receivedBytes: state.receivedBytes + data.byteLength,
        });
        state.pendingJournal = [];
      } else if (
        state.pendingJournal.length + 1 >= JOURNAL_FLUSH_CHUNKS ||
        chunkIndex === state.totalChunks - 1
      ) {
        await this.flushJournal(state, chunkIndex);
      } else {
        state.pendingJournal.push(chunkIndex);
      }

      // Update in-memory receivedChunks only after disk & snapshot/journal write succeeds.
      state.receivedChunks[chunkIndex] = true;
      state.receivedCount++;
      state.receivedBytes += data.byteLength;
      if (state.runningHash) {
        if (state.hashedContiguousChunks === chunkIndex) {
          state.runningHash.update(data);
          state.hashedContiguousChunks++;
        } else {
          state.runningHash = null;
        }
      }
    });
  }

  async listReceived(transferId: string, fileIndex: number): Promise<ReceivedSummary | null> {
    if (!TRANSFER_ID_RE.test(transferId) || !Number.isInteger(fileIndex) || fileIndex < 0) {
      return null;
    }
    return this.serialized(this.key(transferId, fileIndex), async () => {
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
    });
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

  async finalize(
    transferId: string,
    fileIndex: number,
    expectedSha256?: string,
  ): Promise<FinalizeResult> {
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
      await this.flushJournal(state);
      const finalizeStartedAt = Date.now();
      let sha256: string;
      if (state.runningHash && state.hashedContiguousChunks === state.totalChunks) {
        sha256 = state.runningHash.digest('hex');
      } else {
        this.finalizeRehashCount += 1;
        sha256 = await this.hashFile(state.tempPath);
      }
      this.finalizeCount += 1;
      this.lastFinalizeDurationMs = Math.max(0, Date.now() - finalizeStartedAt);
      state.runningHash = null;
      // Reject before the .part file is renamed: a hash mismatch must never
      // become a "completed" file in Downloads. Remove the partial so a retry
      // starts clean instead of trusting corrupted bytes as a resume prefix.
      if (expectedSha256 && sha256 !== expectedSha256) {
        await fs.promises.rm(state.tempPath, { force: true });
        await fs.promises.rm(state.metaPath, { force: true });
        await fs.promises.rm(state.journalPath, { force: true });
        this.states.delete(key);
        throw new Error('SHA-256 verification failed; the partial file was discarded.');
      }
      const finalPath = await publishReceivedFile(state.tempPath, this.config.downloadDir, state.name);
      await fs.promises.rm(state.metaPath, { force: true }).catch(() => {});
      await fs.promises.rm(state.journalPath, { force: true }).catch(() => {});
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
      await fs.promises.rm(state.journalPath, { force: true });
      this.states.delete(key);
    });
  }

  /** Flush resumable progress and close file handles on server shutdown. */
  async dispose(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.hasSnapshot) await this.flushJournal(state).catch(() => {});
      await this.closeFd(state);
    }
    this.states.clear();
  }
}
