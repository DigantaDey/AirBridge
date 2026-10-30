import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import tlsModule from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SignalingHub, isLocalMachineAddress } from './signalingHub.js';
import { getLanUrls, startMdnsResponder, type MdnsHandle } from './mdnsService.js';
import {
  isLoopbackAddress,
  resolveTlsMaterial,
  shouldEnableHttps,
  type AirBridgeTlsMaterial,
} from './tls.js';
import {
  createMacDaemonConfig,
  getDaemonStatus,
  loadPersistedDownloadDir,
  openFolderInFileManager,
  persistDownloadDir,
  saveBufferToLocalDownloads,
  sanitizeFilename,
  setDownloadDir,
  type MacDaemonConfig,
} from './macIntegration.js';
import { PartialReceiveStore } from './partialReceive.js';
import {
  createSystemClipboardProvider,
  type HostClipboardProvider,
} from './hostClipboard.js';
import { registerCliBeamRoutes, type CliBeamSession } from './cliSendSession.js';

export interface AirBridgeServerOptions {
  port?: number;
  host?: string;
  mode?: 'development' | 'production' | 'test';
  enableMdns?: boolean;
  daemonConfig?: Partial<MacDaemonConfig>;
  cliSessions?: Map<string, CliBeamSession>;
  onCliDownload?: (fileName: string, remoteIp: string) => void;
  /**
   * Background OS clipboard bridge for the local host browser client.
   * Enabled by default outside test mode unless `AIRBRIDGE_CLIPBOARD_WATCH=0`.
   */
  hostClipboard?: boolean | HostClipboardProvider;
  hostClipboardPollMs?: number;
  /**
   * Serve HTTPS (on the same port as HTTP). Defaults to on outside tests:
   * browsers refuse WebCrypto on `http://<LAN-IP>`, so a phone cannot use
   * AirBridge at all without it. Set `AIRBRIDGE_HTTPS=0` to opt out.
   */
  https?: boolean;
  /** Override for tests: opens a folder in the OS file manager. */
  openFolder?: (targetPath: string) => Promise<void>;
  /** Where the received-files folder choice is persisted. Default ~/.airbridge/settings.json; set to null to disable. */
  receivedFolderSettingsPath?: string | null;
  /** Path to a PEM certificate (e.g. mkcert). Implies `https: true`. */
  tlsCertPath?: string;
  /** Path to the PEM private key matching `tlsCertPath`. */
  tlsKeyPath?: string;
  /** Directory for the auto-generated local CA. Default `~/.airbridge/tls`. */
  tlsDir?: string;
  /**
   * Built client files (path -> base64) embedded into a single-file desktop
   * executable at packaging time. Used when no dist/client directory exists
   * on disk — see scripts/generate-embedded-client.mjs.
   */
  clientAssets?: Record<string, string>;
  /** App version reported by /api/downloads (desktop entries pass pkg.version). */
  version?: string;
}

export interface AirBridgeServerInstance {
  app: Express;
  httpServer: http.Server;
  /** HTTPS server sharing the same app/port when TLS is enabled, else null. */
  httpsServer: https.Server | null;
  /** Certificate material in use, or null in plain-HTTP mode. */
  tls: AirBridgeTlsMaterial | null;
  /** Protocol used for LAN (phone-facing) URLs. */
  protocol: 'http' | 'https';
  hub: SignalingHub;
  port: number;
  lanUrls: string[];
  close: () => Promise<void>;
}

/**
 * One-time bootstrap paths that stay reachable over plain HTTP from the LAN
 * even when HTTPS is on:
 *  - the local CA download (a phone cannot fetch the CA it does not yet
 *    trust over a trusted connection; its fingerprint is printed on the Mac
 *    so the user can verify it out-of-band before installing), and
 *  - CLI "beam" downloads, which are single-purpose token links that need
 *    no secure-context browser APIs and predate HTTPS support.
 * Everything else on HTTP from a non-loopback address redirects to HTTPS.
 */
function isHttpBootstrapPath(urlPath: string): boolean {
  return (
    urlPath === '/airbridge-ca.crt' ||
    urlPath === '/airbridge-ca.pem' ||
    urlPath === '/api/beam' ||
    urlPath.startsWith('/api/beam/')
  );
}

export async function createAirBridgeServer(
  options: AirBridgeServerOptions = {}
): Promise<AirBridgeServerInstance> {
  const mode =
    options.mode ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  const host = options.host ?? '0.0.0.0';
  const requestedPort = options.port ?? Number.parseInt(process.env.PORT || '3000', 10);

  const tlsEnabled = shouldEnableHttps({
    mode,
    https: options.https,
    tlsCertPath: options.tlsCertPath,
    tlsKeyPath: options.tlsKeyPath,
    tlsDir: options.tlsDir,
  });
  const tls = tlsEnabled
    ? await resolveTlsMaterial({
        tlsCertPath: options.tlsCertPath,
        tlsKeyPath: options.tlsKeyPath,
        tlsDir: options.tlsDir,
      })
    : null;
  const protocol: 'http' | 'https' = tls ? 'https' : 'http';

  const daemonCfg = createMacDaemonConfig(options.daemonConfig);
  const cliSessions = options.cliSessions ?? new Map<string, CliBeamSession>();

  const app = express();
  app.disable('x-powered-by');
  // Baseline hardening for every response (the CA download included).
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (mode !== 'development') {
      // Everything the app loads is same-origin (no CDNs, no inline scripts);
      // style 'unsafe-inline' covers React style attributes only.
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self' ws: wss:",
          "worker-src 'self' blob:",
          "media-src 'self' blob:",
          "manifest-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; ')
      );
      res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
      );
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
    next();
  });

  const httpServer = http.createServer(app);
  const httpsServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, app) : null;
  // SecureContext for the dispatcher's explicit TLS termination (see below).
  const httpsSecureContext = tls
    ? tlsModule.createSecureContext({ key: tls.key, cert: tls.cert })
    : null;
  // Disable Nagle on transfer sockets (also covers dispatcher-handed sockets
  // in TLS mode, which arrive via emit('connection')).
  httpServer.on('connection', (socket) => (socket as net.Socket).setNoDelay(true));
  httpsServer?.on('connection', (socket) => (socket as net.Socket).setNoDelay(true));
  let activePort = requestedPort;
  let mdns: MdnsHandle | null = null;

  const clipboardProvider: HostClipboardProvider | null =
    typeof options.hostClipboard === 'object' && options.hostClipboard !== null
      ? options.hostClipboard
      : options.hostClipboard === true ||
          (options.hostClipboard === undefined &&
            mode !== 'test' &&
            process.env.AIRBRIDGE_CLIPBOARD_WATCH !== '0')
        ? createSystemClipboardProvider()
        : null;

  const hub = new SignalingHub({
    getLanUrls: () => getLanUrls(activePort, protocol),
    getDaemonStatus: () => getDaemonStatus(daemonCfg),
    clipboardProvider,
    clipboardPollMs: options.hostClipboardPollMs,
  });

  if (tls) {
    // Local CA download for first-time trust setup on the phone. Registered
    // before the redirect so it also works over plain HTTP (see above).
    const serveCa = (_req: Request, res: Response) => {
      if (!tls.caCertPem) {
        res
          .status(404)
          .send('This server uses a provided TLS certificate; there is no generated CA to install.');
        return;
      }
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', 'attachment; filename="airbridge-ca.crt"');
      res.send(tls.caCertPem);
    };
    app.get('/airbridge-ca.crt', serveCa);
    app.get('/airbridge-ca.pem', serveCa);

    // Plain HTTP from another device can never be a browser secure context,
    // so send those browsers to the exact same URL over HTTPS (same port —
    // the listener below accepts both). Loopback stays HTTP-friendly
    // because `http://localhost` is already treated as secure.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const encrypted = Boolean((req.socket as TLSSocket).encrypted);
      if (
        encrypted ||
        isLoopbackAddress(req.socket.remoteAddress) ||
        isHttpBootstrapPath(req.path)
      ) {
        next();
        return;
      }
      const hostHeader = req.headers.host;
      if (!hostHeader) {
        res.status(400).send('Missing Host header.');
        return;
      }
      res.redirect(308, `https://${hostHeader}${req.originalUrl}`);
    });
  }

  // Received-files folder settings. Loopback only: a phone (or any LAN
  // device / website reaching this port) must not be able to move where the
  // host saves files or pop open folders on the host's screen.
  const isLoopbackRequest = (req: Request) => isLoopbackAddress(req.socket.remoteAddress);
  // The daemon save/stream routes are restricted to this machine, not just
  // loopback: the host's own browser is often reached over a LAN IP, and the
  // WebSocket layer already treats that as a host client. Remote devices (a
  // phone, another laptop) have an address that is not one of our interfaces.
  const isLocalMachineRequest = (req: Request) => isLocalMachineAddress(req.socket.remoteAddress);
  const receivedSettingsPath = options.receivedFolderSettingsPath === null || (options.receivedFolderSettingsPath === undefined && mode === 'test')
    ? null
    : options.receivedFolderSettingsPath ?? path.join(path.dirname(tls?.certDir ?? path.join(process.env.HOME ?? '', '.airbridge', 'tls')), 'settings.json');
  if (receivedSettingsPath && !options.daemonConfig?.downloadDir && !process.env.AIRBRIDGE_DOWNLOAD_DIR) {
    const persisted = await loadPersistedDownloadDir(receivedSettingsPath);
    if (persisted) daemonCfg.downloadDir = persisted;
  }
  // Ensure the received folder exists when daemon is enabled (default in dev/prod)
  if (daemonCfg.enabled) {
    await fs.promises.mkdir(daemonCfg.downloadDir, { recursive: true }).catch(() => {});
  }
  // Disk-backed streaming receive: chunk-level .part files + persisted manifests
  // so a huge inbound file never lives entirely in browser memory and an
  // interrupted transfer can resume from disk.
  const receiveStore = new PartialReceiveStore(daemonCfg);
  app.get('/api/received-folder', (req, res) => {
    if (!isLoopbackRequest(req)) { res.status(403).json({ error: 'Received-folder settings are restricted to this device.' }); return; }
    res.json({ downloadDir: daemonCfg.downloadDir, autoSaveToDownloads: daemonCfg.enabled && daemonCfg.autoSaveToDownloads, enabled: daemonCfg.enabled });
  });
  app.use('/api/received-folder', express.json({ limit: '16kb' }));
  app.put('/api/received-folder', async (req, res) => {
    if (!isLoopbackRequest(req)) { res.status(403).json({ error: 'Received-folder settings are restricted to this device.' }); return; }
    try {
      const downloadDir = await setDownloadDir(daemonCfg, (req.body as { downloadDir?: unknown })?.downloadDir);
      if (receivedSettingsPath) await persistDownloadDir(receivedSettingsPath, downloadDir).catch(() => {});
      // Clients that change the folder almost certainly want files saved there.
      daemonCfg.enabled = true; daemonCfg.autoSaveToDownloads = true;
      res.json({ ok: true, downloadDir, autoSaveToDownloads: true, enabled: true });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid folder' }); }
  });
  app.post('/api/received-folder/open', async (req, res) => {
    if (!isLoopbackRequest(req)) { res.status(403).json({ error: 'Opening folders is restricted to this device.' }); return; }
    try {
      const requested = (req.body as { path?: unknown } | undefined)?.path;
      let target = daemonCfg.downloadDir;
      if (typeof requested === 'string' && requested) {
        // Only reveal paths inside the received-files folder.
        const resolved = path.resolve(requested);
        const root = path.resolve(daemonCfg.downloadDir);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) { res.status(400).json({ error: 'Path is outside the received-files folder.' }); return; }
        target = resolved;
      }
      await fs.promises.mkdir(daemonCfg.downloadDir, { recursive: true });
      await (options.openFolder ?? openFolderInFileManager)(target);
      res.json({ ok: true, path: target });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'Could not open folder' }); }
  });

  // Loopback-only filesystem browser for the "Browse…" path picker in Settings.
  // Exposes only directory listings, never file contents.
  app.get('/api/fs/list', async (req, res) => {
    if (!isLoopbackRequest(req)) { res.status(403).json({ error: 'Filesystem browsing is restricted to this device.' }); return; }
    try {
      const raw = typeof req.query.path === 'string' ? req.query.path : daemonCfg.downloadDir;
      const resolved = path.resolve(raw);
      const stat = await fs.promises.stat(resolved);
      if (!stat.isDirectory()) { res.status(400).json({ error: 'Not a directory' }); return; }
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, isDirectory: true, path: path.join(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(resolved);
      res.json({
        current: resolved,
        parent: parent !== resolved ? parent : null,
        home: os.homedir(),
        downloadDir: daemonCfg.downloadDir,
        entries: dirs,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Cannot list directory' });
    }
  });
  app.post('/api/fs/mkdir', express.json({ limit: '16kb' }), async (req, res) => {
    if (!isLoopbackRequest(req)) { res.status(403).json({ error: 'Restricted to this device.' }); return; }
    try {
      const { base, name } = req.body as { base?: unknown; name?: unknown };
      if (typeof base !== 'string' || typeof name !== 'string') { res.status(400).json({ error: 'base and name required' }); return; }
      const sanitized = name.replace(/[\\/:*?\"<>|\\x00-\\x1f]/g, '_').trim();
      if (!sanitized || sanitized === '.' || sanitized === '..') { res.status(400).json({ error: 'Invalid folder name' }); return; }
      const resolvedBase = path.resolve(base);
      const stat = await fs.promises.stat(resolvedBase).catch(() => null);
      if (!stat?.isDirectory()) { res.status(400).json({ error: 'Base is not a directory' }); return; }
      const target = path.join(resolvedBase, sanitized);
      await fs.promises.mkdir(target, { recursive: true });
      res.json({ ok: true, path: target });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'Cannot create folder' }); }
  });

  // Health & runtime diagnostics endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'AirBridge Warp Server',
      protocol: 'warp-v1',
      e2ee: 'ECDH-P256-AES-256-GCM',
      uptimeSec: Math.round(process.uptime()),
      ...hub.getStats(),
      lanUrls: getLanUrls(activePort, protocol),
      https: tls !== null,
      tlsSource: tls?.source ?? null,
      caFingerprintSha256: tls?.caFingerprintSha256 ?? null,
      requestProtocol: (req.socket as TLSSocket).encrypted ? 'https' : 'http',
      mdnsActive: mdns?.active ?? false,
      // Full daemon status (incl. the local download path) only for the host itself.
      localDaemon: isLocalMachineAddress(req.socket.remoteAddress) ? getDaemonStatus(daemonCfg) : { ...getDaemonStatus(daemonCfg), downloadDir: undefined },
    });
  });

  // Optional local MacBook daemon direct-to-Downloads endpoint (strictly loopback + opt-in)
  app.post(
    '/api/daemon/save',
    express.raw({ type: 'application/octet-stream', limit: '512mb' }),
    async (req, res) => {
      if (!daemonCfg.enabled) {
        res.status(403).json({ error: 'Local daemon mode is disabled.' });
        return;
      }
      if (!isLocalMachineAddress(req.socket.remoteAddress)) {
        res.status(403).json({ error: 'Direct disk save is restricted to this machine.' });
        return;
      }
      const rawName = String(req.headers['x-airbridge-filename'] || 'download.bin');
      try {
        const sender = req.headers['x-airbridge-sender']
          ? decodeURIComponent(String(req.headers['x-airbridge-sender']))
          : undefined;
        const filename = decodeURIComponent(rawName);
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
        const saved = await saveBufferToLocalDownloads(daemonCfg, filename, body, sender);
        res.json({ ok: true, ...saved });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to save to local Downloads',
        });
      }
    }
  );

  // Streaming, disk-backed chunk receive (loopback + opt-in daemon). The host
  // browser decrypts each chunk and posts it here; the server writes it to a
  // .part file at its declared offset. Keeps huge files off browser memory and
  // makes an interrupted transfer resumable from disk.
  app.post(
    '/api/daemon/receive-chunk',
    express.raw({ type: 'application/octet-stream', limit: '4mb' }),
    async (req: Request, res: Response) => {
      if (!daemonCfg.enabled) {
        res.status(403).json({ error: 'Local daemon mode is disabled.' });
        return;
      }
      if (!isLocalMachineRequest(req)) {
        res.status(403).json({ error: 'Direct disk save is restricted to this machine.' });
        return;
      }
      const h = req.headers;
      const transferId = String(h['x-airbridge-transfer'] || '');
      const fileIndex = Number(h['x-airbridge-file']);
      const chunkIndex = Number(h['x-airbridge-chunk']);
      const rawName = decodeURIComponent(String(h['x-airbridge-name'] || ''));
      const senderName = h['x-airbridge-sender']
        ? decodeURIComponent(String(h['x-airbridge-sender']))
        : undefined;
      const size = Number(h['x-airbridge-size']);
      const chunkSize = Number(h['x-airbridge-chunk-size']);
      const totalChunks = Number(h['x-airbridge-total-chunks']);
      if (
        !/^[0-9a-f]{16}$/.test(transferId) ||
        !Number.isInteger(fileIndex) ||
        fileIndex < 0 ||
        !Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        !rawName ||
        !Number.isFinite(size) ||
        size < 0 ||
        !Number.isFinite(chunkSize) ||
        chunkSize <= 0 ||
        !Number.isInteger(totalChunks) ||
        totalChunks < 1
      ) {
        res.status(400).json({ error: 'Invalid chunk request.' });
        return;
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      try {
        await receiveStore.writeChunk(
          {
            transferId,
            fileIndex,
            name: sanitizeFilename(rawName),
            senderName,
            size,
            chunkSize,
            totalChunks,
          },
          chunkIndex,
          new Uint8Array(body),
        );
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Failed to write chunk.',
        });
      }
    }
  );

  // Query what a resumable receive has already landed on disk (loopback only).
  // ---------------------------------------------------------------------------
  // Download center. The web UI links here so any device on the LAN can grab
  // the right build: artifacts dropped next to the running binary (or in
  // $AIRBRIDGE_ARTIFACTS_DIR) are served directly; everything else links to
  // GitHub Releases. Only exact, whitelisted file names are ever served —
  // no directory listing, no path traversal.
  // ---------------------------------------------------------------------------
  const githubRepo = process.env.AIRBRIDGE_GITHUB_REPO || 'DigantaDey/AirBridge';
  const DOWNLOADABLE_NAME =
    /^AirBridge-(macos|linux|windows)-(x64|arm64)(-musl)?(\.exe)?$|^AirBridge\.apk$|^SHA256SUMS\.txt$/;
  const artifactDirs = (): string[] => {
    const dirs: string[] = [path.dirname(process.execPath), process.cwd()];
    if (process.env.AIRBRIDGE_ARTIFACTS_DIR) {
      dirs.unshift(path.resolve(process.env.AIRBRIDGE_ARTIFACTS_DIR));
    }
    return [...new Set(dirs)];
  };
  const findArtifact = async (
    name: string
  ): Promise<{ abs: string; size: number } | null> => {
    for (const dir of artifactDirs()) {
      const abs = path.resolve(dir, name);
      // Basename-only: the resolved file must sit directly in a search dir.
      if (path.dirname(abs) !== path.resolve(dir)) continue;
      try {
        const st = await fs.promises.stat(abs);
        if (st.isFile()) return { abs, size: st.size };
      } catch {
        /* try the next dir */
      }
    }
    return null;
  };

  app.get('/api/downloads', async (_req: Request, res: Response) => {
    const names = new Set<string>();
    for (const dir of artifactDirs()) {
      try {
        for (const entry of await fs.promises.readdir(dir)) {
          if (DOWNLOADABLE_NAME.test(entry)) names.add(entry);
        }
      } catch {
        /* unreadable dir — skip */
      }
    }
    const files: Array<{ name: string; size: number; url: string }> = [];
    for (const name of [...names].sort()) {
      const found = await findArtifact(name);
      if (found) files.push({ name, size: found.size, url: `/downloads/${name}` });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      version: options.version ?? process.env.AIRBRIDGE_VERSION ?? 'dev',
      platform: process.platform,
      arch: process.arch,
      githubRelease: `https://github.com/${githubRepo}/releases/latest`,
      files,
    });
  });

  app.get('/downloads/:name', async (req: Request, res: Response) => {
    const name = req.params.name;
    if (!name || !DOWNLOADABLE_NAME.test(name)) {
      res.status(404).end();
      return;
    }
    const found = await findArtifact(name);
    if (!found) {
      res.status(404).end();
      return;
    }
    res.setHeader(
      'Content-Type',
      name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    fs.createReadStream(found.abs)
      .on('error', () => res.destroy())
      .pipe(res);
  });

  app.get('/api/daemon/received', async (req: Request, res: Response) => {
    if (!daemonCfg.enabled) {
      res.status(403).json({ error: 'Local daemon mode is disabled.' });
      return;
    }
    if (!isLocalMachineRequest(req)) {
      res.status(403).json({ error: 'Received-files state is restricted to this machine.' });
      return;
    }
    const transferId = String(req.query.transferId || '');
    const fileIndex = Number(req.query.fileIndex);
    const summary = await receiveStore.listReceived(transferId, fileIndex);
    if (!summary) {
      res.json({ ok: true, complete: false });
      return;
    }
    res.json({ ok: true, ...summary });
  });

  // Finalize a complete .part file: verify, hash, rename, notify (loopback only).
  app.post(
    '/api/daemon/finalize',
    express.json({ limit: '16kb' }),
    async (req: Request, res: Response) => {
      if (!daemonCfg.enabled) {
        res.status(403).json({ error: 'Local daemon mode is disabled.' });
        return;
      }
      if (!isLocalMachineRequest(req)) {
        res.status(403).json({ error: 'Received-files state is restricted to this machine.' });
        return;
      }
      const body = req.body as { transferId?: unknown; fileIndex?: unknown };
      const transferId = typeof body.transferId === 'string' ? body.transferId : '';
      const fileIndex = Number(body.fileIndex);
      if (!/^[0-9a-f]{16}$/.test(transferId) || !Number.isInteger(fileIndex) || fileIndex < 0) {
        res.status(400).json({ error: 'transferId and fileIndex are required.' });
        return;
      }
      try {
        const result = await receiveStore.finalize(transferId, fileIndex);
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Failed to finalize file.',
        });
      }
    }
  );

  // Drop a partial receive (used when a transfer is cancelled/declined).
  app.post(
    '/api/daemon/discard',
    express.json({ limit: '16kb' }),
    async (req: Request, res: Response) => {
      if (!daemonCfg.enabled) {
        res.status(403).json({ error: 'Local daemon mode is disabled.' });
        return;
      }
      if (!isLocalMachineRequest(req)) {
        res.status(403).json({ error: 'Received-files state is restricted to this machine.' });
        return;
      }
      const body = req.body as { transferId?: unknown; fileIndex?: unknown };
      const transferId = typeof body.transferId === 'string' ? body.transferId : '';
      const fileIndex = Number(body.fileIndex);
      if (!/^[0-9a-f]{16}$/.test(transferId) || !Number.isInteger(fileIndex) || fileIndex < 0) {
        res.status(400).json({ error: 'transferId and fileIndex are required.' });
        return;
      }
      await receiveStore.discard(transferId, fileIndex);
      res.json({ ok: true });
    }
  );

  // CLI instant beam routes
  registerCliBeamRoutes(app, cliSessions, (file, ip) => {
    options.onCliDownload?.(file.name, ip);
  });

  // Attach WebSocket upgrade strictly for /ws (leaving Vite HMR upgrades untouched).
  // With TLS the same port serves both schemes, so listen on both servers;
  // non-/ws upgrades arriving over TLS are re-emitted on the HTTP server,
  // where Vite's HMR socket is attached in development.
  const handleUpgrade =
    (fromTls: boolean) =>
    (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        if (url.pathname === '/ws') {
          hub.wss.handleUpgrade(req, socket, head, (ws) => {
            hub.wss.emit('connection', ws, req);
          });
        } else if (fromTls) {
          httpServer.emit('upgrade', req, socket, head);
        }
      } catch {
        socket.destroy();
      }
    };
  httpServer.on('upgrade', handleUpgrade(false));
  httpsServer?.on('upgrade', handleUpgrade(true));

  if (mode === 'development') {
    // Split the specifier so bundlers (Bun single-file executables) never try
    // to resolve vite at build time: the packaged binary is always
    // production-mode, but a static import would drag the whole dev server
    // into the bundle or fail the build.
    const viteSpecifier = ['vi', 'te'].join('');
    const { createServer: createViteServer } = await import(viteSpecifier);
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        allowedHosts: true,
        hmr: {
          server: httpServer,
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (mode === 'production') {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Resolve dist/client whether running via tsx (src/server) or node (dist/server/server)
    const candidates = [
      path.resolve(__dirname, '../../client'),
      path.resolve(__dirname, '../../dist/client'),
      path.resolve(process.cwd(), 'dist/client'),
    ];
    const clientDist = candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));

    if (clientDist) {
      app.use(express.static(clientDist, { index: false }));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(clientDist, 'index.html'));
      });
    } else if (options.clientAssets && options.clientAssets['/index.html']) {
      // Single-file desktop executables carry the built client inside the
      // binary (path -> base64). Disk always wins when present so a
      // development checkout keeps serving fresh assets.
      const assets = options.clientAssets;
      const indexHtml = Buffer.from(assets['/index.html'], 'base64');
      const contentTypeFor = (filePath: string): string => {
        if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
        if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
        if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
        if (filePath.endsWith('.svg')) return 'image/svg+xml';
        if (filePath.endsWith('.webmanifest')) return 'application/manifest+json';
        if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
        if (filePath.endsWith('.png')) return 'image/png';
        if (filePath.endsWith('.woff2')) return 'font/woff2';
        return 'application/octet-stream';
      };
      app.get('*', (req, res) => {
        const requested = req.path === '/' ? '/index.html' : req.path;
        const embedded = assets[requested];
        if (embedded !== undefined) {
          res.setHeader('Content-Type', contentTypeFor(requested));
          res.setHeader(
            'Cache-Control',
            requested === '/index.html'
              ? 'no-cache'
              : 'public, max-age=31536000, immutable'
          );
          res.send(Buffer.from(embedded, 'base64'));
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(indexHtml);
      });
    }
  }

  // When TLS is enabled, a single TCP listener peeks at the first byte of
  // each connection (0x16 starts a TLS ClientHello) and hands the socket to
  // the HTTPS or HTTP server. That keeps one port for both schemes: an old
  // http:// QR code redirects to https:// on the same port, and a manually
  // typed https://<LAN-IP>:3000 no longer hits a plaintext port (the
  // "SSL received a record that exceeded the maximum permissible length"
  // error). Sockets are handed over directly, never proxied, so
  // `remoteAddress` still identifies the real peer.
  let dispatcher: net.Server | null = null;
  if (httpsServer) {
    dispatcher = net.createServer((socket) => {
      // Relayed transfer frames are large and latency-sensitive; Nagle's
      // algorithm only adds delay here.
      socket.setNoDelay(true);
      const onPeekError = () => socket.destroy();
      socket.once('error', onPeekError);
      socket.once('data', (firstChunk) => {
        socket.removeListener('error', onPeekError);
        socket.pause();
        if (firstChunk[0] === 0x16 && httpsSecureContext) {
          // Terminate TLS here, then hand the *decrypted* stream to the HTTP
          // server. Emitting 'connection' on an https.Server only TLS-wraps
          // inside Node's native listen path; hand-off sockets bypass it in
          // Bun (the single-file desktop runtime), which silently parsed the
          // ClientHello as HTTP and answered "400 Bad Request". Wrapping
          // explicitly keeps `req.socket.encrypted` semantics (TLSSocket)
          // identical for both runtimes.
          socket.unshift(firstChunk);
          const tlsSocket = new tlsModule.TLSSocket(socket, {
            isServer: true,
            secureContext: httpsSecureContext,
            ALPNProtocols: ['http/1.1'],
          });
          tlsSocket.on('error', () => tlsSocket.destroy());
          tlsSocket.on('secure', () => {
            httpServer.emit('connection', tlsSocket);
            process.nextTick(() => {
              if (!tlsSocket.destroyed) tlsSocket.resume();
            });
          });
        } else {
          socket.unshift(firstChunk);
          httpServer.emit('connection', socket);
          process.nextTick(() => {
            if (!socket.destroyed) socket.resume();
          });
        }
      });
    });
  }

  const listeningServer: net.Server = dispatcher ?? httpServer;
  await new Promise<void>((resolve, reject) => {
    listeningServer.once('error', reject);
    listeningServer.listen(requestedPort, host, () => {
      const addr = listeningServer.address();
      if (addr && typeof addr === 'object') {
        activePort = addr.port;
      }
      resolve();
    });
  });

  if (options.enableMdns !== false && mode !== 'test') {
    mdns = startMdnsResponder(activePort);
  }

  return {
    app,
    httpServer,
    httpsServer,
    tls,
    protocol,
    hub,
    port: activePort,
    lanUrls: getLanUrls(activePort, protocol),
    async close() {
      mdns?.close();
      hub.close();
      await receiveStore.dispose();
      // The internal HTTP/HTTPS servers don't listen directly in TLS mode;
      // drop their live connections so the dispatcher's close can finish.
      httpServer.closeAllConnections?.();
      httpsServer?.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        listeningServer.close(() => resolve());
      });
      if (dispatcher) {
        httpServer.close();
        httpsServer?.close();
      }
    },
  };
}

/** Human-facing startup guidance shared by the direct entrypoint. */
export function describeTlsSetup(instance: AirBridgeServerInstance): string[] {
  const lines: string[] = [];
  const lanList = instance.lanUrls.length > 0 ? instance.lanUrls.join(', ') : 'none detected';
  lines.push(`⚡ AirBridge Warp Server listening on port ${instance.port}`);
  lines.push(`💻 On this Mac:        http://localhost:${instance.port}  (secure as-is)`);
  lines.push(`📱 On your phone:      ${lanList}`);
  if (!instance.tls) {
    lines.push(
      '⚠️  HTTPS is OFF: phone browsers will block AirBridge on a Wi-Fi address ("Secure connection required"). Restart without AIRBRIDGE_HTTPS=0 / --http to enable it.'
    );
  } else if (instance.tls.source === 'generated') {
    const httpLanBase = instance.lanUrls[0]?.replace(/^https:/, 'http:');
    lines.push('🔐 HTTPS uses a locally generated certificate authority' +
      (instance.tls.certDir ? ` (${instance.tls.certDir})` : '') +
      '.');
    if (instance.tls.caFingerprintSha256) {
      lines.push(`   CA SHA-256 fingerprint: ${instance.tls.caFingerprintSha256}`);
    }
    if (httpLanBase) {
      lines.push(
        `   First time on a phone: install the CA from ${httpLanBase}/airbridge-ca.crt`
      );
      lines.push(
        '   (Android: Settings → Security → Install a certificate → CA certificate),'
      );
      lines.push(
        '   check the fingerprint above matches, then open the https:// address — no warnings after that.'
      );
    }
  } else {
    lines.push('🔐 HTTPS uses the configured TLS certificate (AIRBRIDGE_TLS_CERT).');
  }
  return lines;
}

// Direct entrypoint execution (tsx/node running this file). Single-file
// desktop executables are excluded: inside a Bun-compiled binary both
// argv[1] and import.meta.url resolve to the same virtual `/$bunfs/...`
// path, which would make this guard match and silently boot a second
// dev-mode server (which then fails trying to import vite).
const currentFile = fileURLToPath(import.meta.url);
const isCompiledBinary = currentFile.includes('$bunfs');
if (
  !isCompiledBinary &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(currentFile)
) {
  createAirBridgeServer()
    .then((instance) => {
      console.log(`\n${describeTlsSetup(instance).join('\n')}\n`);
    })
    .catch((err) => {
      console.error('Failed to start AirBridge server:', err);
      process.exit(1);
    });
}
