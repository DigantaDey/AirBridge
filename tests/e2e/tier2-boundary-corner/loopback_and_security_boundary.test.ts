import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createTestServer, withTempDir } from '../harness/index.js';
import { isLoopbackAddress } from '../../../src/server/tls.js';
import { isLocalMachineAddress } from '../../../src/server/signalingHub.js';
import { isSameOriginRequest } from '../../../src/server/httpSafety.js';
import type { IncomingMessage } from 'node:http';

describe('Tier 2 Boundary: Loopback Enforcement, Origin CSRF & Security Boundaries', () => {
  it('blocks cross-origin HTTP API requests with mismatched Origin header (403)', async () => {
    const server = await createTestServer();
    try {
      const res = await fetch(`${server.httpUrl}/api/health`, {
        headers: { Origin: 'https://evil.example.com' },
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('blocks cross-site HTTP API requests declaring Sec-Fetch-Site: cross-site (403)', async () => {
    const server = await createTestServer();
    try {
      const res = await fetch(`${server.httpUrl}/api/health`, {
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('rejects WebSocket /ws upgrades from foreign Origins with 403', async () => {
    const server = await createTestServer();
    try {
      const ws = new WebSocket(server.wsUrl, {
        headers: { Origin: 'https://attacker.invalid' },
      });
      const failed = await new Promise<boolean>((resolve) => {
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode === 403));
        ws.once('error', () => resolve(true));
      });
      expect(failed).toBe(true);
      ws.close();
    } finally {
      await server.close();
    }
  });

  it('permits same-origin browser requests and Origin-less native mobile requests', () => {
    const sameOriginReq = {
      headers: { host: '192.168.1.5:3411', origin: 'https://192.168.1.5:3411' },
    } as IncomingMessage;
    const nativeAppReq = {
      headers: { host: '192.168.1.5:3411' },
    } as IncomingMessage;
    const spoofedOriginReq = {
      headers: { host: '192.168.1.5:3411', origin: 'https://evil.com' },
    } as IncomingMessage;

    expect(isSameOriginRequest(sameOriginReq)).toBe(true);
    expect(isSameOriginRequest(nativeAppReq)).toBe(true);
    expect(isSameOriginRequest(spoofedOriginReq)).toBe(false);
  });

  it('blocks path traversal outside downloadDir on POST /api/received-folder/open', async () => {
    await withTempDir('ab-t2-sec-open-', async (dir) => {
      const server = await createTestServer({
        daemonConfig: {
          enabled: true,
          autoSaveToDownloads: true,
          downloadDir: dir,
          notifyOnReceive: false,
          revealInFinder: false,
        },
        openFolder: async () => {},
      });
      try {
        const res = await fetch(`${server.httpUrl}/api/received-folder/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/etc' }),
        });
        expect(res.status).toBe(400);
      } finally {
        await server.close();
      }
    });
  });

  it('rejects empty, dot, and dot-dot directory creation in POST /api/fs/mkdir', async () => {
    await withTempDir('ab-t2-mkdir-', async (dir) => {
      const server = await createTestServer();
      try {
        for (const badName of ['.', '..', '   ']) {
          const res = await fetch(`${server.httpUrl}/api/fs/mkdir`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base: dir, name: badName }),
          });
          expect(res.status).toBe(400);
        }
      } finally {
        await server.close();
      }
    });
  });

  it('sanitizes slashes in /api/fs/mkdir so folder names cannot escape base directory', async () => {
    await withTempDir('ab-t2-mkdir-esc-', async (dir) => {
      const server = await createTestServer();
      try {
        const res = await fetch(`${server.httpUrl}/api/fs/mkdir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base: dir, name: '../escaped' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { path: string };
        expect(body.path.startsWith(dir)).toBe(true);
      } finally {
        await server.close();
      }
    });
  });

  it('denies all local daemon endpoints (/api/daemon/*) when daemon mode is disabled', async () => {
    const server = await createTestServer({
      daemonConfig: {
        enabled: false,
        autoSaveToDownloads: false,
        downloadDir: '/tmp',
        notifyOnReceive: false,
        revealInFinder: false,
      },
    });
    try {
      const [saveRes, recRes, finRes, discRes] = await Promise.all([
        fetch(`${server.httpUrl}/api/daemon/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: Buffer.from([1, 2, 3]),
        }),
        fetch(`${server.httpUrl}/api/daemon/received?transferId=0123456789abcdef&fileIndex=0`),
        fetch(`${server.httpUrl}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: '0123456789abcdef', fileIndex: 0 }),
        }),
        fetch(`${server.httpUrl}/api/daemon/discard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: '0123456789abcdef', fileIndex: 0 }),
        }),
      ]);
      expect(saveRes.status).toBe(403);
      expect(recRes.status).toBe(403);
      expect(finRes.status).toBe(403);
      expect(discRes.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('returns 403 on /api/daemon/background-pair-code when backgroundClipboard is disabled', async () => {
    const server = await createTestServer({ hostClipboard: false });
    try {
      const res = await fetch(`${server.httpUrl}/api/daemon/background-pair-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairCode: 'AAA222' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('rejects non-whitelisted artifact paths on /downloads/:name against directory traversal', async () => {
    const server = await createTestServer();
    try {
      const [res1, res2, res3] = await Promise.all([
        fetch(`${server.httpUrl}/downloads/..%2Fpackage.json`),
        fetch(`${server.httpUrl}/downloads/arbitrary.sh`),
        fetch(`${server.httpUrl}/downloads/.env`),
      ]);
      expect(res1.status).toBe(404);
      expect(res2.status).toBe(404);
      expect(res3.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('sets strict HTTP hardening headers and removes X-Powered-By', async () => {
    const server = await createTestServer({ mode: 'production', https: false });
    try {
      const res = await fetch(`${server.httpUrl}/api/health`);
      expect(res.headers.get('x-powered-by')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    } finally {
      await server.close();
    }
  });

  it('identifies true loopback vs LAN IPv4/IPv6 addresses accurately without trusting forwarded headers', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.55')).toBe(false);
    expect(isLoopbackAddress('10.0.0.2')).toBe(false);
    expect(isLocalMachineAddress('192.168.250.254')).toBe(false);
  });

  it('serves /airbridge-ca.crt and /airbridge-ca.pem over plain HTTP bootstrap when TLS is enabled', async () => {
    await withTempDir('ab-t2-tls-ca-', async (tlsDir) => {
      const server = await createTestServer({
        mode: 'production',
        https: true,
        tlsDir,
      });
      try {
        expect(server.httpUrl.startsWith('https://')).toBe(true);
        const httpBase = `http://127.0.0.1:${server.port}`;
        const [crtRes, pemRes] = await Promise.all([
          fetch(`${httpBase}/airbridge-ca.crt`),
          fetch(`${httpBase}/airbridge-ca.pem`),
        ]);
        expect(crtRes.status).toBe(200);
        expect(pemRes.status).toBe(200);
        const crtText = await crtRes.text();
        expect(crtText).toContain('-----BEGIN CERTIFICATE-----');
      } finally {
        await server.close();
      }
    });
  });

  it('blocks /api/fs/list on non-directory file paths with HTTP 400', async () => {
    await withTempDir('ab-t2-fslist-', async (dir) => {
      const server = await createTestServer();
      try {
        const res = await fetch(
          `${server.httpUrl}/api/fs/list?path=${encodeURIComponent(`${dir}/does-not-exist`)}`,
        );
        expect(res.status).toBe(400);
      } finally {
        await server.close();
      }
    });
  });

  it('isolates /api/received-folder PUT errors on non-writable/nonexistent root edge cases gracefully', async () => {
    const server = await createTestServer();
    try {
      const res = await fetch(`${server.httpUrl}/api/received-folder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadDir: '' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
