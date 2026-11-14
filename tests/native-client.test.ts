// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeClient, createAirBridgeClient } from '../src/client/engine/nativeClient.js';
import type { AirBridgeNativeBridge } from '../src/client/engine/nativeShell.js';
import { WarpClient, type WarpClientSnapshot, type TransferSessionView } from '../src/client/engine/warpClient.js';

const initial = (): WarpClientSnapshot & { ready: boolean; revision: number; clipboardRevision: number } => ({
  ready: true, revision: 1, clipboardRevision: 0,
  connectionState: 'connected', peerId: '1111111111111111', pairCode: 'ABCDEF', formattedPairCode: 'ABC-DEF',
  visibility: 'paired-only', myDevice: null, lanUrls: [],
  localDaemon: { enabled: false, platform: 'android', hostname: '', autoSaveToDownloads: true, clipboardBridge: true },
  peers: [], peerSecurity: {}, transfers: [], clipboardItems: [], trustedPeerKeys: [], autoClipboardSync: true, clipboardReceiveEnabled: true,
});
const transfer = (status: TransferSessionView['status']): TransferSessionView => ({
  transferId: 'aaaaaaaaaaaaaaaa', peerId: '2222222222222222', peerName: 'Mac', peerPlatform: 'macos', sasCode: '123 · 456',
  direction: 'incoming', status, transport: 'ws-relay', files: [], totalBytes: 10, transferredBytes: status === 'completed' ? 10 : 0,
  speedBytesPerSec: 0, etaSeconds: null, startedAt: 1, receivedFiles: [],
});
function fixture() {
  let state: Partial<ReturnType<typeof initial>> = initial();
  const commands: Array<Record<string, unknown>> = [];
  const bridge = {
    nativeEngineVersion: () => 1,
    engineAttach: vi.fn(() => true),
    engineSnapshot: vi.fn((revision?: number) => revision === state.revision ? '' : JSON.stringify(state)),
    engineCommand: vi.fn((json: string) => {
      const command = JSON.parse(json) as Record<string, unknown>;
      commands.push(command);
      return JSON.stringify({ ok: true, result: command.method === 'sendFiles' ? transfer('pending-accept') : null });
    }),
  } as unknown as AirBridgeNativeBridge;
  return { bridge, commands, setState: (next: Partial<ReturnType<typeof initial>>) => { state = next; } };
}

const clients: NativeClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.stop());
  delete window.AirBridgeAndroid;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('service-owned Android client', () => {
  it('selects native capability without opening a competing browser peer', () => {
    const f = fixture();
    window.AirBridgeAndroid = f.bridge;
    expect(createAirBridgeClient({})).toBeInstanceOf(NativeClient);
    delete window.AirBridgeAndroid;
    expect(createAirBridgeClient({})).toBeInstanceOf(WarpClient);
  });

  it('sends opaque URI metadata, never reads or base64-encodes file contents', async () => {
    const f = fixture(); const client = new NativeClient(f.bridge); clients.push(client);
    const sliceBytes = vi.fn(() => { throw new Error('File bytes reached JavaScript'); });
    await client.start();
    await client.sendFiles('2222222222222222', [{ nativeSourceId: 'opaque-picker-capability', name: 'movie.mp4', type: 'video/mp4', size: 2 ** 33, sliceBytes }]);
    expect(sliceBytes).not.toHaveBeenCalled();
    expect(f.commands).toEqual([{ method: 'sendFiles', peerId: '2222222222222222', files: [{ sourceId: 'opaque-picker-capability', size: 2 ** 33 }] }]);
    await expect(client.sendFiles('peer', [{ name: 'ungranted', size: 1, type: 'x', sliceBytes }])).rejects.toThrow('file picker');
  });

  it('reattaches to native transfers after UI destruction without stopping them', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.setState({ ...initial(), transfers: [transfer('transferring')] });
    const first = new NativeClient(f.bridge); clients.push(first);
    await first.start(); first.stop();
    f.setState({ ...initial(), revision: 2, transfers: [transfer('completed')] });
    const second = new NativeClient(f.bridge); clients.push(second);
    await second.start();
    expect(second.getSnapshot().transfers[0].status).toBe('completed');
    expect(f.commands).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('merges clipboard deltas, skips hidden UI polling and catches up on return', async () => {
    vi.useFakeTimers();
    const f = fixture(); const onClipboard = vi.fn();
    const client = new NativeClient(f.bridge, { onIncomingClipboard: onClipboard }); clients.push(client);
    await client.start();
    const item = { beamId: 'clip', peerId: 'peer', peerName: 'Mac', direction: 'incoming' as const, text: 'background text', contentType: 'text' as const, timestamp: 1, sasCode: '123 · 456' };
    f.setState({ ...initial(), revision: 2, clipboardRevision: 1, clipboardItems: [item] });
    await vi.advanceTimersByTimeAsync(250);
    expect(onClipboard).toHaveBeenCalledExactlyOnceWith(item);
    const { clipboardItems: _items, ...delta } = { ...initial(), revision: 3, clipboardRevision: 1 };
    f.setState(delta);
    await vi.advanceTimersByTimeAsync(250);
    expect(client.getSnapshot().clipboardItems).toEqual([item]);
    expect(onClipboard).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const reads = vi.mocked(f.bridge.engineSnapshot!).mock.calls.length;
    f.setState({ ...initial(), revision: 4, clipboardRevision: 1, clipboardItems: [item], transfers: [transfer('completed')] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.bridge.engineSnapshot).toHaveBeenCalledTimes(reads);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(client.getSnapshot().transfers[0].status).toBe('completed');
  });

  it('surfaces native command failures rather than silently starting a browser fallback', async () => {
    const f = fixture(); const client = new NativeClient(f.bridge); clients.push(client);
    await client.start();
    vi.mocked(f.bridge.engineCommand!).mockReturnValue(JSON.stringify({ ok: false, error: 'Storage is full' }));
    await expect(client.acceptIncomingTransfer('id')).rejects.toThrow('Storage is full');
    client.stop();
    expect(f.commands.some((command) => command.method === 'stop')).toBe(false);
  });
});
