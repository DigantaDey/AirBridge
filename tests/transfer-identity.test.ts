// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, WarpClient, type TransferSessionView } from '../src/client/engine/warpClient.js';
import {
  derivePeerSession, encryptBinaryChunk, encryptControlPayload, generateIdentityKeyPair,
  type IdentityKeys,
} from '../src/client/engine/crypto.js';
import {
  encodeEncryptedChunkFrame, type ControlPayload, type EncryptedEnvelope,
  type FileManifestItem, type PeerSummary, type ServerToClientMessage,
} from '../src/shared/protocol.js';

const peerId = '1111111111111111';
const transferId = 'abababababababab';
const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const files: FileManifestItem[] = [{
  index: 0, name: 'empty.bin', relativePath: 'original/empty.bin', size: 0,
  mimeType: 'application/octet-stream', totalChunks: 1, chunkSize: CHUNK_SIZE,
}];
const offer = (id = transferId, manifest = files): ControlPayload => ({
  kind: 'transfer-offer', transferId: id, files: manifest,
  totalBytes: manifest.reduce((sum, file) => sum + file.size, 0), createdAt: Date.now(),
});
type ReceiveState = { session: TransferSessionView; finalizeChain: Promise<void> };
type Internals = {
  keys: IdentityKeys;
  peers: PeerSummary[];
  connectionState: string;
  ws: { close(): void } | null;
  incomingStates: Map<string, ReceiveState>;
  transfers: TransferSessionView[];
  peerControlQueues: Map<string, Promise<void>>;
  sendControlMessage(peer: string, payload: ControlPayload, encrypt: boolean): Promise<void>;
  handleIncomingControl(peer: string, envelope: EncryptedEnvelope): Promise<void>;
  handleIncomingEncryptedChunk(peer: string, bytes: Uint8Array, transport: 'ws-relay'): Promise<void>;
  handleServerMessage(message: ServerToClientMessage): void;
};

async function fixture() {
  const client = new WarpClient({ storage: null, enableWebRtc: false });
  const state = client as unknown as Internals;
  const keys = await generateIdentityKeyPair();
  const original = await generateIdentityKeyPair();
  state.keys = keys;
  state.connectionState = 'connected';
  const peer = (identity: IdentityKeys): PeerSummary => ({
    peerId, discoveryScope: 'paired', connectedAt: 0,
    device: { name: 'Same name', platform: 'android', model: 'Phone', formFactor: 'phone',
      deviceId: '2222222222222222', publicKey: identity.publicKeyB64 },
  });
  state.peers = [peer(original)];
  const send = vi.spyOn(state, 'sendControlMessage').mockResolvedValue();
  const session = (identity: IdentityKeys) => derivePeerSession(identity.privateKey, identity.publicKeyB64, keys.publicKeyB64);
  const envelope = async (payload: ControlPayload, identity = original) =>
    encryptControlPayload((await session(identity)).aesKey, payload);
  const control = async (payload: ControlPayload, identity = original) =>
    state.handleIncomingControl(peerId, await envelope(payload, identity));
  return { client, state, original, peer, send, session, envelope, control };
}

async function completeEmptyFile(f: Awaited<ReturnType<typeof fixture>>) {
  await f.control(offer());
  const receive = f.state.incomingStates.get(transferId)!;
  await f.client.acceptIncomingTransfer(transferId);
  const { iv, ciphertext } = await encryptBinaryChunk((await f.session(f.original)).aesKey, new Uint8Array(), 0, 0);
  await f.state.handleIncomingEncryptedChunk(peerId, encodeEncryptedChunkFrame({
    transferId, fileIndex: 0, chunkIndex: 0, iv, ciphertext,
  }), 'ws-relay');
  await f.control({ kind: 'file-complete', transferId, fileIndex: 0, sha256: emptySha });
  await f.control({ kind: 'transfer-complete', transferId });
  await receive.finalizeChain;
  expect(receive.session.status).toBe('completed');
  expect(receive.session.receivedFiles[0].verified).toBe(true);
  f.send.mockClear();
}

describe('transfer consent and verified receipt identity', () => {
  it('replays completion only to the original key and the exact offered manifest', async () => {
    const f = await fixture();
    try {
      await completeEmptyFile(f);
      for (const changes of [
        { relativePath: 'changed/empty.bin' }, { name: 'different.bin' },
        { mimeType: 'text/plain' }, { size: 1 }, { chunkSize: 16 * 1024 },
      ]) {
        await f.control(offer(transferId, [{ ...files[0], ...changes }]));
        expect(f.send).not.toHaveBeenCalled();
      }
      const impostor = await generateIdentityKeyPair();
      f.state.peers = [f.peer(impostor)]; // identical peerId, deviceId and name
      await f.control(offer(), impostor);
      await f.control({ kind: 'transfer-complete', transferId }, impostor);
      expect(f.send).not.toHaveBeenCalled();

      f.state.peers = [f.peer(f.original)];
      await f.control(offer());
      expect(f.send).toHaveBeenCalledWith(peerId, expect.objectContaining({
        kind: 'transfer-accept', resumeFromChunks: { 0: 1 },
      }), true);
      expect(f.send).toHaveBeenCalledWith(peerId, {
        kind: 'transfer-complete-ack', transferId, verified: true,
      }, true);
    } finally { f.client.stop(); }
  });

  it('never treats peer-reported completed history as local verification', async () => {
    const f = await fixture();
    try {
      await f.control({ kind: 'history-sync', transfers: [{
        transferId, peerName: 'Same name', peerPlatform: 'android', direction: 'outgoing',
        status: 'completed', transport: 'ws-relay', files, totalBytes: 0,
        transferredBytes: 0, startedAt: 1, completedAt: 2, sasCode: '123 · 456',
      }] });
      expect(f.state.transfers[0].status).toBe('completed');
      await f.control(offer());
      await f.control({ kind: 'transfer-complete', transferId });
      expect(f.send).not.toHaveBeenCalled();
    } finally { f.client.stop(); }
  });

  it('does not transfer consent to a changed key or changed relative path', async () => {
    const f = await fixture();
    try {
      await f.control(offer());
      await f.client.acceptIncomingTransfer(transferId);
      f.send.mockClear();
      await f.control(offer(transferId, [{ ...files[0], relativePath: 'other/empty.bin' }]));
      expect(f.send).not.toHaveBeenCalled();
      const impostor = await generateIdentityKeyPair();
      f.state.peers = [f.peer(impostor)];
      await f.control({ kind: 'transfer-cancel', transferId }, impostor);
      await f.control(offer(), impostor);
      expect(f.state.incomingStates.get(transferId)?.session.status).toBe('transferring');
      expect(f.send).not.toHaveBeenCalled();
    } finally { f.client.stop(); }
  });

  it('bounds pending incoming offers before allocating chunk arrays', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 20; i++) await f.control(offer(i.toString(16).padStart(16, '0')));
      expect(f.state.incomingStates.size).toBe(16);
      expect(f.state.transfers).toHaveLength(16);
      expect(f.send).toHaveBeenCalledTimes(4);
      for (const call of f.send.mock.calls) expect(call[1].kind).toBe('transfer-decline');
    } finally { f.client.stop(); }
  });

  it('keeps peer history from cancelling live receive/storage ownership', async () => {
    const f = await fixture();
    try {
      await f.control(offer());
      const receive = f.state.incomingStates.get(transferId);
      await f.control({ kind: 'history-sync', transfers: [{
        transferId, peerName: 'Same name', peerPlatform: 'android', direction: 'outgoing',
        status: 'cancelled', transport: 'ws-relay', files, totalBytes: 0,
        transferredBytes: 0, startedAt: 1, completedAt: 2, sasCode: '123 · 456',
      }] });
      expect(f.state.incomingStates.get(transferId)).toBe(receive);
      expect(receive?.session.status).toBe('pending-accept');
    } finally { f.client.stop(); }
  });

  it('drops controls queued on a previous socket and controls encrypted across a reconnect', async () => {
    const f = await fixture();
    try {
      const oldSocket = { close() {} };
      const newSocket = { close() {} };
      const envelope = await f.envelope(offer());
      f.state.ws = oldSocket;
      f.state.handleServerMessage({ type: 'transfer-control', from: peerId, envelope });
      const queued = f.state.peerControlQueues.get(peerId);
      f.state.ws = newSocket;
      await queued;
      expect(f.state.incomingStates.size).toBe(0);

      f.send.mockRestore();
      const sending = f.state.sendControlMessage(peerId, offer(), true);
      f.state.ws = oldSocket;
      await expect(sending).rejects.toThrow(/Connection or peer identity changed/);
    } finally { f.client.stop(); }
  });
});
