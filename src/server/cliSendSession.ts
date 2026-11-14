import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { asyncRoute } from './httpSafety.js';
import { formatBytes } from '../shared/protocol.js';

export interface CliBeamFile {
  index: number;
  absPath: string;
  name: string;
  size: number;
}

export interface CliBeamSession {
  token: string;
  files: CliBeamFile[];
  createdAt: number;
  /** Beam links are bearer credentials on the LAN: they expire. */
  expiresAt: number;
  downloads: number;
}

export const CLI_BEAM_TTL_MS = 15 * 60 * 1000;

// Brute-force throttling for token guesses (per remote address).
const failedLookups = new Map<string, { count: number; windowStart: number }>();
function tokenGuessThrottled(ip: string): boolean {
  const now = Date.now();
  const entry = failedLookups.get(ip);
  if (!entry || now - entry.windowStart > 60_000) {
    if (failedLookups.size >= 1_024) {
      for (const [address, attempt] of failedLookups) if (now - attempt.windowStart > 60_000) failedLookups.delete(address);
      if (failedLookups.size >= 1_024) failedLookups.delete(failedLookups.keys().next().value!);
    }
    failedLookups.set(ip, { count: 0, windowStart: now }); return false;
  }
  return entry.count >= 20;
}
function noteFailedLookup(ip: string): void {
  const entry = failedLookups.get(ip);
  if (entry) entry.count += 1;
}
function liveSession(sessions: Map<string, CliBeamSession>, token: string, ip: string): CliBeamSession | null {
  const session = sessions.get(token);
  if (session && session.expiresAt > Date.now()) return session;
  if (session) sessions.delete(token);
  if (!tokenGuessThrottled(ip)) noteFailedLookup(ip);
  return null;
}

export function registerCliBeamRoutes(
  app: Express,
  sessions: Map<string, CliBeamSession>,
  onDownloadComplete?: (file: CliBeamFile, remoteIp: string) => void
): void {
  app.get('/api/beam/:token', (req: Request, res: Response) => {
    if (tokenGuessThrottled(req.ip || '')) { res.status(429).json({ error: 'Too many attempts.' }); return; }
    const session = liveSession(sessions, String(req.params.token), req.ip || '');
    if (!session) {
      res.status(404).json({ error: 'Beam token expired or invalid.' });
      return;
    }
    res.json({
      token: session.token,
      createdAt: session.createdAt,
      files: session.files.map((f) => ({
        index: f.index,
        name: f.name,
        size: f.size,
        formattedSize: formatBytes(f.size),
        downloadUrl: `/api/beam/${session.token}/file/${f.index}`,
      })),
    });
  });

  app.get('/api/beam/:token/file/:idx', asyncRoute(async (req: Request, res: Response) => {
    if (tokenGuessThrottled(req.ip || '')) { res.status(429).send('Too many attempts.'); return; }
    const session = liveSession(sessions, String(req.params.token), req.ip || '');
    if (!session) { res.status(404).send('Beam token expired or invalid.'); return; }
    const idx = Number(req.params.idx);
    const file = Number.isInteger(idx) && session.files.find((f) => f.index === idx);
    if (!file) { res.status(404).send('File not found.'); return; }

    // Open once and stat that descriptor: deletion/replacement between an
    // exists/stat/read sequence must neither crash the process nor leak FDs.
    const handle = await fs.promises.open(file.absPath, 'r').catch(() => null);
    if (!handle) { res.status(404).send('File not found.'); return; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) { res.status(404).send('File not found.'); return; }
      const total = stat.size;
      let start = 0;
      let end = total - 1;
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const first = match?.[1] ? Number(match[1]) : null;
        const last = match?.[2] ? Number(match[2]) : null;
        if (first === null && last !== null) start = Math.max(0, total - last);
        else if (first !== null) { start = first; if (last !== null) end = Math.min(last, total - 1); }
        if (!match || (first === null && (last === null || last === 0)) ||
            !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) {
          res.status(416).setHeader('Content-Range', `bytes */${total}`); res.end(); return;
        }
        res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.type(path.extname(file.name) || 'application/octet-stream');
      const safeName = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      res.setHeader('Content-Length', String(total === 0 ? 0 : end - start + 1));
      try {
        const stream = handle.createReadStream({ start, ...(total > 0 ? { end } : {}), autoClose: false });
        await pipeline(stream, res);
        if (!range) {
          session.downloads += 1;
          onDownloadComplete?.(file, req.ip || req.socket.remoteAddress || 'peer');
        }
      } catch {
        // pipeline tears down both ends on disconnect/read errors, including
        // ranged downloads. A disappeared client must not leave a file open.
        if (!res.destroyed) res.destroy();
      }
    } finally { await handle.close(); }
  }));
}

export async function createCliBeamSession(filePaths: string[]): Promise<CliBeamSession> {
  const files: CliBeamFile[] = [];
  for (let i = 0; i < filePaths.length; i++) {
    const absPath = path.resolve(filePaths[i]);
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${absPath}`);
    }
    files.push({
      index: i,
      absPath,
      name: path.basename(absPath),
      size: stat.size,
    });
  }

  const now = Date.now();
  return {
    // 256-bit bearer token (was 96-bit) — anyone with the link can download,
    // so it must be unguessable and short-lived.
    token: crypto.randomBytes(32).toString('base64url'),
    files,
    createdAt: now,
    expiresAt: now + CLI_BEAM_TTL_MS,
    downloads: 0,
  };
}
