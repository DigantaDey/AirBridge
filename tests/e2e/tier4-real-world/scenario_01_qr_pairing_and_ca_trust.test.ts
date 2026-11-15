import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  derivePeerSession,
  generateIdentityKeyPair,
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
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          }),
        );
      })
      .on('error', reject);
  });
}

function pemSha256Hex(pem: string): string {
  const b64 = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, '');
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

describe('Tier 4 Scenario 01: QR Pairing, CA Bootstrap Trust & SAS Handshake', { timeout: 30_000 }, () => {
  it('completes QR URL bootstrap, HTTP CA pin verification, untrusted rejection, trusted WSS upgrade, and encrypted file drop', async () => {
    await withTempDir('ab-t4-s01-ca-', async (tlsDir) => {
      const server = await startTestServer({
        mode: 'production',
        https: true,
        tlsDir,
        enableMdns: false,
        hostClipboard: false,
      });
      const phone = await OpaquePeer.create({ name: 'PixelQR', platform: 'android', pairCode: 'QR8822' });
      const mac = await OpaquePeer.create({ name: 'MacQR', platform: 'macos', pairCode: 'QR8822' });

      try {
        // Step 1: Scanned QR points to HTTPS host + plain HTTP bootstrap endpoints on same port
        expect(server.httpUrl.startsWith('https://')).toBe(true);
        const httpHealth = await httpGetText(`http://127.0.0.1:${server.port}/api/health`);
        expect(httpHealth.status).toBe(200);
        const healthMeta = JSON.parse(httpHealth.body) as {
          caFingerprintSha256: string;
          https: boolean;
          e2ee: string;
        };
        expect(healthMeta.https).toBe(true);
        expect(healthMeta.e2ee).toBe('ECDH-P256-AES-256-GCM');

        // Step 2: Fetch CA certificate over bootstrap endpoint and verify SHA-256 pin
        const caRes = await httpGetText(`http://127.0.0.1:${server.port}/airbridge-ca.crt`);
        expect(caRes.status).toBe(200);
        const actualSha = pemSha256Hex(caRes.body).toLowerCase();
        const advertisedSha = healthMeta.caFingerprintSha256.replace(/:/g, '').toLowerCase();
        expect(actualSha).toBe(advertisedSha);

        // Step 3: Verify strict TLS rejects WSS without installing CA trust anchor
        const unpinned = await OpaquePeer.create({ name: 'Unpinned', pairCode: 'QR8822' });
        await expect(
          unpinned.connect(server.wsUrl, undefined, { rejectUnauthorized: true }),
        ).rejects.toThrow();

        // Step 4: Verify trusted HTTPS & WSS connect using downloaded CA and complete SAS-backed drop
        const trustedHealth = await httpsGetJson(
          `https://127.0.0.1:${server.port}/api/health`,
          caRes.body,
        );
        expect(trustedHealth.status).toBe(200);
        expect(trustedHealth.body.requestProtocol).toBe('https');

        await Promise.all([
          phone.connect(server.wsUrl, undefined, { ca: caRes.body }),
          mac.connect(server.wsUrl, undefined, { ca: caRes.body }),
        ]);
        await phone.waitForPeer((p) => p.peerId === mac.peerId);

        const payload = createSyntheticBuffer(384 * 1024, 17);
        const { sha256 } = await streamSingleFileAndVerify(
          mac,
          phone,
          randomTransferId(),
          'qr-trusted-photo.jpg',
          payload,
          128 * 1024,
        );
        expect(sha256).toBe(await computeSha256(payload));
      } finally {
        await phone.disconnect().catch(() => {});
        await mac.disconnect().catch(() => {});
        await server.close();
      }
    });
  });

  it('matches /airbridge-ca.pem byte-for-byte with /airbridge-ca.crt and detects impersonators via SAS mismatch', async () => {
    await withTempDir('ab-t4-s01-sas-', async (tlsDir) => {
      const server = await startTestServer({
        mode: 'production',
        https: true,
        tlsDir,
        enableMdns: false,
        hostClipboard: false,
      });
      try {
        const [crt, pem] = await Promise.all([
          httpGetText(`http://127.0.0.1:${server.port}/airbridge-ca.crt`),
          httpGetText(`http://127.0.0.1:${server.port}/airbridge-ca.pem`),
        ]);
        expect(crt.status).toBe(200);
        expect(pem.status).toBe(200);
        expect(crt.body).toBe(pem.body);

        const phoneKey = await generateIdentityKeyPair();
        const macKey = await generateIdentityKeyPair();
        const mitmKey = await generateIdentityKeyPair();

        const phoneSess = await derivePeerSession(phoneKey.privateKey, phoneKey.publicKeyB64, macKey.publicKeyB64);
        const macSess = await derivePeerSession(macKey.privateKey, macKey.publicKeyB64, phoneKey.publicKeyB64);
        const fakeSess = await derivePeerSession(phoneKey.privateKey, phoneKey.publicKeyB64, mitmKey.publicKeyB64);

        expect(phoneSess.sasCode).toMatch(/^\d{3} · \d{3}$/);
        expect(phoneSess.sasCode).toBe(macSess.sasCode);
        expect(phoneSess.sasCode).not.toBe(fakeSess.sasCode);
      } finally {
        await server.close();
      }
    });
  });
});
