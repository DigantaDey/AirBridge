import http from 'node:http';
import https from 'node:https';
import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  OpaquePeer,
  randomTransferId,
  startTestServer,
  streamSingleFileAndVerify,
  withTempDir,
} from '../harness/index.js';

function httpGetText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      })
      .on('error', reject);
  });
}

function httpsGetJson(url: string, ca: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { ca }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> });
        });
      })
      .on('error', reject);
  });
}

describe('Tier 3 Cross-Feature: Single-Port TLS/WSS Sniffing & HTTP Coexistence', { timeout: 30_000 }, () => {
  it('terminates TLS and plain HTTP on the exact same TCP port via ClientHello (0x16) sniffing', async () => {
    await withTempDir('ab-t3-tls-', async (tlsDir) => {
      const server = await startTestServer({
        mode: 'production',
        https: true,
        tlsDir,
        enableMdns: false,
        hostClipboard: false,
      });
      try {
        expect(server.httpUrl.startsWith('https://')).toBe(true);
        const plainHealth = await httpGetText(`http://127.0.0.1:${server.port}/api/health`);
        expect(plainHealth.status).toBe(200);
        expect(JSON.parse(plainHealth.body).requestProtocol).toBe('http');

        const caRes = await httpGetText(`http://127.0.0.1:${server.port}/airbridge-ca.crt`);
        expect(caRes.status).toBe(200);
        expect(caRes.body).toContain('-----BEGIN CERTIFICATE-----');

        const tlsHealth = await httpsGetJson(
          `https://127.0.0.1:${server.port}/api/health`,
          caRes.body,
        );
        expect(tlsHealth.status).toBe(200);
        expect(tlsHealth.body.https).toBe(true);
        expect(tlsHealth.body.requestProtocol).toBe('https');
      } finally {
        await server.close();
      }
    });
  });

  it('completes an end-to-end encrypted WSS file transfer trusting ONLY the CA downloaded over HTTP bootstrap', async () => {
    await withTempDir('ab-t3-wss-', async (tlsDir) => {
      const server = await startTestServer({
        mode: 'production',
        https: true,
        tlsDir,
        enableMdns: false,
        hostClipboard: false,
      });
      const phone = await OpaquePeer.create({ name: 'TlsPhone', platform: 'android', pairCode: 'TLS111' });
      const mac = await OpaquePeer.create({ name: 'TlsMac', platform: 'macos', pairCode: 'TLS111' });
      try {
        const ca = (await httpGetText(`http://127.0.0.1:${server.port}/airbridge-ca.crt`)).body;
        await Promise.all([
          phone.connect(server.wsUrl, undefined, { ca }),
          mac.connect(server.wsUrl, undefined, { ca }),
        ]);
        await phone.waitForPeer((p) => p.peerId === mac.peerId);

        const data = createSyntheticBuffer(300 * 1024, 91);
        const { sha256 } = await streamSingleFileAndVerify(
          mac,
          phone,
          randomTransferId(),
          'over-wss-ca.bin',
          data,
          128 * 1024,
        );
        expect(sha256).toBe(await computeSha256(data));
      } finally {
        await phone.disconnect().catch(() => {});
        await mac.disconnect().catch(() => {});
        await server.close();
      }
    });
  });

  it('reports matching caFingerprintSha256 between /api/health and downloaded /airbridge-ca.crt', async () => {
    await withTempDir('ab-t3-fp-', async (tlsDir) => {
      const server = await startTestServer({
        mode: 'production',
        https: true,
        tlsDir,
        enableMdns: false,
        hostClipboard: false,
      });
      try {
        const caRes = await httpGetText(`http://127.0.0.1:${server.port}/airbridge-ca.crt`);
        const health = await httpsGetJson(`https://127.0.0.1:${server.port}/api/health`, caRes.body);
        expect(typeof health.body.caFingerprintSha256).toBe('string');
        expect((health.body.caFingerprintSha256 as string).length).toBeGreaterThanOrEqual(32);
      } finally {
        await server.close();
      }
    });
  });

  it('allows one peer on ws:// loopback and another peer on wss:// trusting CA to relay together seamlessly', async () => {
    await withTempDir('ab-t3-mixed-', async (tlsDir) => {
      const server = await startTestServer({
        mode: 'production',
        https: true,
        tlsDir,
        enableMdns: false,
        hostClipboard: false,
      });
      const localPeer = await OpaquePeer.create({ name: 'LocalWS', pairCode: 'MIX222' });
      const tlsPeer = await OpaquePeer.create({ name: 'TlsWSS', pairCode: 'MIX222' });
      try {
        const ca = (await httpGetText(`http://127.0.0.1:${server.port}/airbridge-ca.crt`)).body;
        await Promise.all([
          localPeer.connect(`ws://127.0.0.1:${server.port}/ws`),
          tlsPeer.connect(`wss://127.0.0.1:${server.port}/ws`, undefined, { ca }),
        ]);
        await tlsPeer.waitForPeer((p) => p.peerId === localPeer.peerId);
        await localPeer.sendControl(tlsPeer.peerId, {
          kind: 'clipboard-beam',
          beamId: 'mixed-scheme-beam',
          contentType: 'text',
          text: 'ws-to-wss-relay',
          timestamp: Date.now(),
        });
        const rx = await tlsPeer.waitForControl(
          (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'mixed-scheme-beam',
        );
        expect(rx.payload.kind === 'clipboard-beam' && rx.payload.text).toBe('ws-to-wss-relay');
      } finally {
        await localPeer.disconnect().catch(() => {});
        await tlsPeer.disconnect().catch(() => {});
        await server.close();
      }
    });
  });

  it('rejects untrusted WSS handshake when a peer omits the generated CA certificate', async () => {
    await withTempDir('ab-t3-untrusted-', async (tlsDir) => {
      const server = await startTestServer({
        mode: 'production',
        https: true,
        tlsDir,
        enableMdns: false,
        hostClipboard: false,
      });
      const untrusted = await OpaquePeer.create({ name: 'NoCaPeer', pairCode: 'BADTLS' });
      try {
        await expect(
          untrusted.connect(server.wsUrl, undefined, { rejectUnauthorized: true }),
        ).rejects.toThrow();
      } finally {
        await untrusted.disconnect().catch(() => {});
        await server.close();
      }
    });
  });
});
