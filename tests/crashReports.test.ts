// @vitest-environment node
/**
 * Crash reports: scrubbing, stable fingerprints, bounded local storage,
 * unclean-shutdown detection, Sentry envelopes and the GitHub fallback,
 * and the local-only HTTP API.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CrashStore,
  beginRun,
  buildCrashReport,
  endRunCleanly,
  fingerprintOf,
  githubIssueUrl,
  loadCrashDsn,
  parseDsn,
  scrub,
  sendCrashReport,
  sentryEnvelope,
} from '../src/server/crashReports.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-crash-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('scrub', () => {
  it('removes personal data and secrets but keeps the useful parts of a stack', () => {
    const ctx = { home: '/Users/diganta', username: 'diganta', hostname: 'Digantas-MacBook-Air' };
    const text = [
      'Error: connect ETIMEDOUT 10.205.95.167:3000 from fe80::1c2b:3aff:fe4d:5e6f',
      '    at Socket.connect (/Users/diganta/.airbridge/bin/airbridge-server:12:7)',
      'pairCode: "K7QX-29PL" url https://host/?pair=K7QX29PL&ca=abc123def',
      'device Digantas-MacBook-Air.local mac a4:83:e7:12:34:56 mail diganta.dey@example.com',
      'key 3q2-7wEj0aZ9kLmN4pQrStUvWxYz012345678_abcd and deadbeefdeadbeefdeadbeefdeadbeef',
      'user diganta wrote /Users/diganta/Downloads/a.txt; digantaX stays',
    ].join('\n');
    const out = scrub(text, ctx);
    for (const leak of ['10.205.95.167', 'fe80::1c2b', 'K7QX', 'abc123def', 'a4:83:e7', 'example.com', '3q2-7wEj0aZ9', 'deadbeefdeadbeef', '/Users/diganta', 'Digantas-MacBook-Air']) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('ETIMEDOUT <ip>:3000');
    expect(out).toContain('at Socket.connect (~/.airbridge/bin/airbridge-server:12:7)');
    expect(out).toContain('user <name> wrote ~/Downloads/a.txt; digantaX stays');
    expect(scrub('at WarpClient.handleSignalingMessageFromServer (x.js:1:2)', ctx)).toContain('handleSignalingMessageFromServer');
  });
});

describe('fingerprints', () => {
  it('group the same bug across machines, builds and line numbers', () => {
    const a = 'TypeError: x\n    at foo (/Users/a/app/server.js:10:5)\n    at bar (/Users/a/app/hub.js:20:1)';
    const b = 'TypeError: y\n    at foo (C:\\Users\\b\\app\\server.js:11:9)\n    at bar (C:\\Users\\b\\app\\hub.js:22:3)';
    const c = 'TypeError: x\n    at baz (/Users/a/app/server.js:10:5)';
    expect(fingerprintOf('TypeError', a)).toBe(fingerprintOf('TypeError', b));
    expect(fingerprintOf('TypeError', a)).not.toBe(fingerprintOf('TypeError', c));
    expect(fingerprintOf('RangeError', a)).not.toBe(fingerprintOf('TypeError', a));
  });
});

describe('CrashStore', () => {
  it('stores private reports, deduplicates bursts, caps the count and deletes', () => {
    const store = new CrashStore(path.join(dir, 'crashes'), { maxReports: 3 });
    const first = buildCrashReport(new TypeError('boom'), 'uncaught-exception', { version: '0.0.6', startedAt: Date.now() - 5000, logTail: ['a', 'b'] });
    expect(store.recordSync(first)).toBe(true);
    expect(store.recordSync(buildCrashReport(new TypeError('boom'), 'uncaught-exception', { version: '0.0.6' }))).toBe(false); // same bug again
    expect(fs.statSync(path.join(dir, 'crashes', `${first.id}.json`)).mode & 0o077).toBe(0);
    expect(store.get(first.id)).toMatchObject({ kind: 'uncaught-exception', name: 'TypeError', message: 'boom', version: '0.0.6', logTail: ['a', 'b'] });
    expect(store.get(first.id)!.uptimeSeconds).toBeGreaterThanOrEqual(5);

    for (let i = 0; i < 5; i++) {
      const e = new Error(`different ${i}`);
      e.stack = `Error: different ${i}\n    at fn${i} (file${i}.js:1:1)`;
      store.recordSync(buildCrashReport(e, 'unhandled-rejection', { version: '0.0.6' }));
    }
    const list = store.list();
    expect(list).toHaveLength(3);
    expect(list[0]!.title).toBe('Error: different 4'); // newest first
    expect(store.get('../../etc/passwd')).toBeNull();

    store.markSent(list[0]!.id, { at: 'now', via: 'github', ref: 'x' });
    expect(store.list()[0]!.sent).toBe(true);
    expect(store.delete(list[0]!.id)).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  it('turns a run that never shut down cleanly into a report at the next start', () => {
    const store = new CrashStore(path.join(dir, 'crashes'));
    fs.writeFileSync(path.join(dir, 'server.log'), 'line one\nwatchdog: unresponsive, restarting\n');
    expect(beginRun(dir, store, '0.0.6')).toBeNull(); // first run
    endRunCleanly(dir);
    expect(beginRun(dir, store, '0.0.6')).toBeNull(); // clean previous run

    // Simulate a previous process that died (pid not alive) without cleanup.
    fs.writeFileSync(path.join(dir, 'run-marker.json'), JSON.stringify({ pid: 999_999, startedAt: Date.now() - 60_000, version: '0.0.5' }));
    const report = beginRun(dir, store, '0.0.6', { isAlive: () => false });
    expect(report).toMatchObject({ kind: 'abnormal-exit', version: '0.0.5' });
    expect(report!.logTail.at(-1)).toContain('watchdog');
    expect(store.list()[0]!.title).toBe('AirBridge 0.0.5 stopped unexpectedly');

    // A previous instance that is still running (second launch) is not a crash.
    fs.writeFileSync(path.join(dir, 'run-marker.json'), JSON.stringify({ pid: 999_998, startedAt: Date.now(), version: '0.0.6' }));
    expect(beginRun(dir, store, '0.0.6', { isAlive: () => true })).toBeNull();
  });
});

describe('sending', () => {
  const report = () => buildCrashReport(Object.assign(new Error('kaput'), { stack: 'Error: kaput\n    at inner (/app/a.js:3:4)\n    at outer (/app/b.js:5:6)' }), 'uncaught-exception', { version: '0.0.6', logTail: ['x'.repeat(400)] });

  it('parses DSNs strictly (HTTPS only, numeric project)', () => {
    expect(parseDsn('https://abc123@o1.ingest.sentry.io/42')).toEqual({ endpoint: 'https://o1.ingest.sentry.io/api/42/envelope/', publicKey: 'abc123' });
    expect(parseDsn('https://k@glitchtip.example.com/sub/7')).toEqual({ endpoint: 'https://glitchtip.example.com/sub/api/7/envelope/', publicKey: 'k' });
    expect(parseDsn('http://k@evil.example.com/7')).toBeNull();
    expect(parseDsn('https://o1.ingest.sentry.io/42')).toBeNull();
    expect(parseDsn('nonsense')).toBeNull();
    expect(loadCrashDsn(dir, {})).toBeNull();
    fs.writeFileSync(path.join(dir, 'crash-dsn'), 'https://k@sentry.example.com/9\n');
    expect(loadCrashDsn(dir, {})?.publicKey).toBe('k');
    expect(loadCrashDsn(dir, { AIRBRIDGE_CRASH_DSN: '' })).toBeNull(); // env opt-out wins
  });

  it('builds a Sentry envelope with the innermost frame last', () => {
    const { body, eventId } = sentryEnvelope(report());
    const [header, item, event] = body.trim().split('\n').map((l) => JSON.parse(l));
    expect(header.event_id).toBe(eventId);
    expect(item.type).toBe('event');
    expect(event.release).toBe('airbridge@0.0.6');
    expect(event.exception.values[0].stacktrace.frames.map((f: { function: string }) => f.function)).toEqual(['outer', 'inner']);
  });

  it('posts to the DSN endpoint, or falls back to a prefilled GitHub issue of bounded size', async () => {
    let received: { auth?: string; body?: string } = {};
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received = { auth: req.headers['x-sentry-auth'] as string, body }; res.end('{}'); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await sendCrashReport(report(), { dsn: parseDsn(`http://pub@127.0.0.1:${port}/5`) });
      expect(result.via).toBe('sentry');
      expect(received.auth).toContain('sentry_key=pub');
      expect(received.body).toContain('"kaput"');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    const big = report();
    big.logTail = Array.from({ length: 80 }, (_, i) => `line ${i} ${'y'.repeat(300)}`);
    const viaGithub = await sendCrashReport(big, { dsn: null });
    expect(viaGithub.via).toBe('github');
    const url = (viaGithub as { url: string }).url;
    expect(url.startsWith('https://github.com/DigantaDey/AirBridge/issues/new?')).toBe(true);
    expect(url.length).toBeLessThan(8000);
    expect(new URL(url).searchParams.get('body')).toContain('Error: kaput');
    expect(githubIssueUrl(report())).toContain('labels=crash');
  });
});

describe('crash report API', () => {
  it('lists, shows, sends (GitHub fallback) and deletes; refuses cross-site requests', async () => {
    const { createAirBridgeServer } = await import('../src/server/index.js');
    const store = new CrashStore(path.join(dir, 'crashes'));
    const report = buildCrashReport(new Error('api boom'), 'uncaught-exception', { version: '0.0.6' });
    store.recordSync(report);
    const srv = await createAirBridgeServer({ port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false, hostClipboard: false, receivedFolderSettingsPath: null, crashStore: store, crashDsn: null });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const list = await (await fetch(`${base}/api/crashes`)).json();
      expect(list).toMatchObject({ supported: true, sendVia: 'github', reports: [{ id: report.id, title: 'Error: api boom', sent: false }] });
      expect((await (await fetch(`${base}/api/crashes/${report.id}`)).json()).stack).toContain('api boom');
      expect((await fetch(`${base}/api/crashes/nope-nope-nope`)).status).toBe(404);

      const crossSite = await fetch(`${base}/api/crashes/${report.id}/send`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
      expect(crossSite.status).toBe(403);
      const sent = await (await fetch(`${base}/api/crashes/${report.id}/send`, { method: 'POST' })).json();
      expect(sent.via).toBe('github');
      expect(sent.url).toContain('issues/new');
      expect(store.list()[0]!.sent).toBe(true);

      expect(await (await fetch(`${base}/api/crashes/${report.id}`, { method: 'DELETE' })).json()).toEqual({ deleted: true });
      expect(store.list()).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });
});
