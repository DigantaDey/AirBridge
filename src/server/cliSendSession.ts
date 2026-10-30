import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
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
  if (!entry || now - entry.windowStart > 60_000) { failedLookups.set(ip, { count: 0, windowStart: now }); return false; }
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

  app.get('/api/beam/:token/file/:idx', async (req: Request, res: Response) => {
    if (tokenGuessThrottled(req.ip || '')) { res.status(429).send('Too many attempts.'); return; }
    const session = liveSession(sessions, String(req.params.token), req.ip || '');
    if (!session) {
      res.status(404).send('Beam token expired or invalid.');
      return;
    }
    const idx = Number.parseInt(String(req.params.idx), 10);
    const file = session.files.find((f) => f.index === idx);
    if (!file || !fs.existsSync(file.absPath)) {
      res.status(404).send('File not found.');
      return;
    }

    const stat = await fs.promises.stat(file.absPath);
    const total = stat.size;
    const encodedName = encodeURIComponent(file.name);
    const ext = path.extname(file.name).toLowerCase();
    const mimeByExt: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.zip': 'application/zip',
      '.apk': 'application/vnd.android.package-archive',
    };

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeByExt[ext] || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.name.replace(/"/g, '_')}"; filename*=UTF-8''${encodedName}`
    );

    const range = req.headers.range;
    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const start = match[1] ? Number.parseInt(match[1], 10) : Math.max(0, total - (match[2] ? Number.parseInt(match[2], 10) : 0));
        const end = match[1] && match[2] ? Math.min(Number.parseInt(match[2], 10), total - 1) : total - 1;
        if (total > 0 && start >= 0 && start <= end && end < total) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', String(end - start + 1));
          fs.createReadStream(file.absPath, { start, end }).pipe(res);
          return;
        }
      }
    }

    res.setHeader('Content-Length', String(total));
    const stream = fs.createReadStream(file.absPath);
    stream.on('end', () => {
      session.downloads += 1;
      onDownloadComplete?.(file, req.ip || req.socket.remoteAddress || 'peer');
    });
    stream.pipe(res);
  });
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
