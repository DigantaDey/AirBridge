import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAirBridgeServer,
  type AirBridgeServerInstance,
} from '../src/server/index.js';
import { getLanIpv4Addresses } from '../src/server/mdnsService.js';
import {
  getCertificateHosts,
  resolveTlsMaterial,
  shouldEnableHttps,
} from '../src/server/tls.js';

interface SimpleResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function simpleGet(
  url: string,
  options: https.RequestOptions = {}
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.get(url, { agent: false, ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
  });
}

describe('shouldEnableHttps', () => {
  it('defaults on for dev/production and off for tests', () => {
    expect(shouldEnableHttps({ mode: 'development' }, {})).toBe(true);
    expect(shouldEnableHttps({ mode: 'production' }, {})).toBe(true);
    expect(shouldEnableHttps({ mode: 'test' }, {})).toBe(false);
  });

  it('honours explicit option, env opt-out and provided certificates', () => {
    expect(shouldEnableHttps({ mode: 'test', https: true }, {})).toBe(true);
    expect(shouldEnableHttps({ mode: 'development' }, { AIRBRIDGE_HTTPS: '0' })).toBe(false);
    expect(shouldEnableHttps({ mode: 'development' }, { AIRBRIDGE_HTTPS: 'off' })).toBe(false);
    expect(shouldEnableHttps({ mode: 'test' }, { AIRBRIDGE_HTTPS: '1' })).toBe(true);
    expect(
      shouldEnableHttps({ mode: 'test' }, { AIRBRIDGE_TLS_CERT: '/tmp/c.pem', AIRBRIDGE_TLS_KEY: '/tmp/k.pem' })
    ).toBe(true);
  });
});

describe('resolveTlsMaterial (generated local CA)', () => {
  let tlsDir: string;

  beforeAll(() => {
    tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-tls-test-'));
  });

  afterAll(() => {
    fs.rmSync(tlsDir, { recursive: true, force: true });
  });

  it('generates a CA + leaf whose chain verifies and covers localhost/LAN hosts', async () => {
    const material = await resolveTlsMaterial({ tlsDir }, {});
    expect(material.source).toBe('generated');
    expect(material.caCertPem).toContain('BEGIN CERTIFICATE');
    expect(material.caFingerprintSha256).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    expect(material.hosts).toContain('localhost');
    expect(material.hosts).toContain('127.0.0.1');
    for (const ip of getLanIpv4Addresses()) {
      expect(material.hosts).toContain(ip);
    }

    const leafPem = material.cert.split('-----BEGIN CERTIFICATE-----')[1];
    expect(leafPem).toBeTruthy();
    const leaf = new crypto.X509Certificate(`-----BEGIN CERTIFICATE-----${leafPem}`);
    const ca = new crypto.X509Certificate(material.caCertPem!);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkHost('localhost')).toBe('localhost');
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
    for (const ip of getCertificateHosts().ipAddresses) {
      expect(leaf.checkIP(ip)).toBe(ip);
    }
    // The files holding private keys must not be world-readable.
    for (const name of ['ca-key.pem', 'key.pem']) {
      expect(fs.statSync(path.join(tlsDir, name)).mode & 0o077).toBe(0);
    }
  }, 30_000);

  it('reuses the CA and leaf across restarts, re-issuing a broken leaf under the same CA', async () => {
    const first = await resolveTlsMaterial({ tlsDir }, {});
    const second = await resolveTlsMaterial({ tlsDir }, {});
    expect(second.caFingerprintSha256).toBe(first.caFingerprintSha256);
    expect(second.leafFingerprintSha256).toBe(first.leafFingerprintSha256);

    fs.writeFileSync(path.join(tlsDir, 'cert.pem'), 'not a certificate');
    const reissued = await resolveTlsMaterial({ tlsDir }, {});
    expect(reissued.caFingerprintSha256).toBe(first.caFingerprintSha256);
    expect(reissued.leafFingerprintSha256).not.toBe(first.leafFingerprintSha256);
  }, 30_000);

  it('uses provided certificate files and rejects half-configured ones', async () => {
    const material = await resolveTlsMaterial(
      {
        tlsCertPath: path.join(tlsDir, 'cert.pem'),
        tlsKeyPath: path.join(tlsDir, 'key.pem'),
      },
      {}
    );
    expect(material.source).toBe('provided');
    expect(material.caCertPem).toBeUndefined();

    await expect(resolveTlsMaterial({ tlsCertPath: path.join(tlsDir, 'cert.pem') }, {})).rejects.toThrow(
      /Both a TLS certificate and key/
    );
  }, 30_000);
});

describe('AirBridge server over HTTPS (same port as HTTP)', () => {
  let server: AirBridgeServerInstance;
  let tlsDir: string;
  let caPem: string;

  beforeAll(async () => {
    tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-tls-server-'));
    server = await createAirBridgeServer({
      port: 0,
      host: '0.0.0.0',
      mode: 'test',
      enableMdns: false,
      https: true,
      tlsDir,
    });
    caPem = fs.readFileSync(path.join(tlsDir, 'ca.pem'), 'utf8');
  }, 30_000);

  afterAll(async () => {
    await server.close();
    fs.rmSync(tlsDir, { recursive: true, force: true });
  });

  it('advertises https LAN URLs for phones', () => {
    expect(server.protocol).toBe('https');
    expect(server.tls?.source).toBe('generated');
    for (const url of server.lanUrls) {
      expect(url.startsWith('https://')).toBe(true);
    }
  });

  it('serves the app over HTTPS to clients that trust the generated CA', async () => {
    const res = await simpleGet(`https://127.0.0.1:${server.port}/api/health`, { ca: caPem });
    expect(res.status).toBe(200);
    const health = JSON.parse(res.body) as Record<string, unknown>;
    expect(health.https).toBe(true);
    expect(health.requestProtocol).toBe('https');
    expect(health.caFingerprintSha256).toBe(server.tls?.caFingerprintSha256);
  });

  it('rejects HTTPS clients that do not trust the CA', async () => {
    await expect(simpleGet(`https://127.0.0.1:${server.port}/api/health`)).rejects.toThrow();
  });

  it('still serves plain HTTP on loopback (already a secure context)', async () => {
    const res = await simpleGet(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as Record<string, unknown>).requestProtocol).toBe('http');
  });

  it('offers the CA over HTTP for first-time phone setup, verifiable by fingerprint', async () => {
    const res = await simpleGet(`http://127.0.0.1:${server.port}/airbridge-ca.crt`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('BEGIN CERTIFICATE');
    expect(new crypto.X509Certificate(res.body).fingerprint256).toBe(
      server.tls?.caFingerprintSha256
    );
  });

  it('redirects non-loopback HTTP to the same URL on HTTPS, QR flow included', async () => {
    // Any non-internal IPv4 works here — even a 169.254.x link-local address
    // (which getLanIpv4Addresses deliberately hides from user-facing URLs)
    // appears to the server as a non-loopback remote.
    const lanIp = Object.values(os.networkInterfaces())
      .flatMap((addrs) => addrs ?? [])
      .find((addr) => addr.family === 'IPv4' && !addr.internal)?.address;
    if (!lanIp) return; // No non-loopback interface in this environment at all.
    const res = await simpleGet(`http://${lanIp}:${server.port}/?pair=ABC123`);
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(`https://${lanIp}:${server.port}/?pair=ABC123`);

    // …but the CA bootstrap download itself must not redirect.
    const ca = await simpleGet(`http://${lanIp}:${server.port}/airbridge-ca.crt`);
    expect(ca.status).toBe(200);
  });

  it('accepts the signaling WebSocket over WSS', async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${server.port}/ws`, { ca: caPem });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.close();
  });
});
