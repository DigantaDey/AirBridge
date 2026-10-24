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
  downloads: number;
}

export function registerCliBeamRoutes(
  app: Express,
  sessions: Map<string, CliBeamSession>,
  onDownloadComplete?: (file: CliBeamFile, remoteIp: string) => void
): void {
  app.get('/api/beam/:token', (req: Request, res: Response) => {
    const session = sessions.get(String(req.params.token));
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
    const session = sessions.get(String(req.params.token));
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
        const start = match[1] ? Number.parseInt(match[1], 10) : 0;
        const end = match[2] ? Math.min(Number.parseInt(match[2], 10), total - 1) : total - 1;
        if (start >= 0 && start <= end && end < total) {
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

  return {
    token: crypto.randomBytes(12).toString('base64url'),
    files,
    createdAt: Date.now(),
    downloads: 0,
  };
}
