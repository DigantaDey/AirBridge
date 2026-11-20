import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import { WarpClient } from '../src/client/engine/warpClient.js';

describe('Diagnostics telemetry extensions across server and client', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('exposes extended signaling, localDaemon, and redacted clipboard telemetry in /api/diagnostics and WarpClient.getDiagnostics()', async () => {
    const server: AirBridgeServerInstance = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      hostClipboard: false,
      backgroundClipboard: false,
      receivedFolderSettingsPath: null,
    });
    cleanups.push(() => server.close());

    const diagJson = await new Promise<Record<string, unknown>>((resolve, reject) => {
      http.get(`http://127.0.0.1:${server.port}/api/diagnostics`, (res) => {
        expect(res.headers['permissions-policy']).toContain('microphone=(self)');
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body) as Record<string, unknown>); } catch (err) { reject(err); }
        });
      }).on('error', reject);
    });

    const signaling = diagJson.signaling as Record<string, unknown>;
    expect(signaling).toMatchObject({
      relayDroppedFrames: 0,
      relayBackpressurePauses: 0,
      relayBackpressureResumes: 0,
      relayMaxBufferedBytes: 0,
      heartbeatTimeouts: 0,
    });

    const daemon = diagJson.localDaemon as Record<string, unknown>;
    expect(daemon).toHaveProperty('finalizeCount');
    expect(daemon).toHaveProperty('finalizeRehashCount');
    expect(daemon).toHaveProperty('lastFinalizeDurationMs');

    expect(diagJson).toHaveProperty('clipboard');

    const client = new WarpClient({
      wsUrl: `ws://127.0.0.1:${server.port}/ws`,
      initialPairCode: server.hub.getDefaultPairCode(),
      enableWebRtc: false,
    });
    cleanups.push(() => client.stop());

    const cDiag = client.getDiagnostics();
    expect(cDiag.transferResumes).toBe(0);
    expect(cDiag.transferChunkRetries).toBe(0);
    expect(cDiag.lastFinalizeDurationMs).toBeNull();
    expect(cDiag.screenShare).toMatchObject({
      activeSessions: 0,
      framesDecoded: 0,
      decodeErrors: 0,
      keyframesReceived: 0,
      pliSent: 0,
      pliReceived: 0,
    });
    expect(cDiag.contacts).toMatchObject({
      savedCount: 0,
      removedByUser: 0,
      clearedOnDisconnect: 0,
    });
    expect(cDiag.callAudio).toMatchObject({
      active: false,
      route: 'phone',
      muted: false,
      framesSent: 0,
      framesReceived: 0,
      packetsDropped: 0,
    });
    expect(cDiag.clipboardBridge).toMatchObject({
      imagesSent: 0,
      imagesReceived: 0,
      autoSyncEnabled: true,
      receiveEnabled: true,
    });
  });
});
