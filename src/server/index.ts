import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SignalingHub } from './signalingHub.js';
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
  saveBufferToLocalDownloads,
  type MacDaemonConfig,
} from './macIntegration.js';
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
   * Serve HTTPS (on the same port as HTTP). Defaults to on outside tests:
   * browsers refuse WebCrypto on `http://<LAN-IP>`, so a phone cannot use
   * AirBridge at all without it. Set `AIRBRIDGE_HTTPS=0` to opt out.
   */
  https?: boolean;
  /** Path to a PEM certificate (e.g. mkcert). Implies `https: true`. */
  tlsCertPath?: string;
  /** Path to the PEM private key matching `tlsCertPath`. */
  tlsKeyPath?: string;
  /** Directory for the auto-generated local CA. Default `~/.airbridge/tls`. */
  tlsDir?: string;
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

  const httpServer = http.createServer(app);
  const httpsServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, app) : null;
  let activePort = requestedPort;
  let mdns: MdnsHandle | null = null;

  const hub = new SignalingHub({
    getLanUrls: () => getLanUrls(activePort, protocol),
    getDaemonStatus: () => getDaemonStatus(daemonCfg),
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
      localDaemon: getDaemonStatus(daemonCfg),
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
      const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (remote !== '127.0.0.1' && remote !== '::1') {
        res.status(403).json({ error: 'Direct disk save is restricted to local loopback.' });
        return;
      }
      const rawName = String(req.headers['x-airbridge-filename'] || 'download.bin');
      const sender = req.headers['x-airbridge-sender']
        ? decodeURIComponent(String(req.headers['x-airbridge-sender']))
        : undefined;
      try {
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
    const { createServer: createViteServer } = await import('vite');
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
      const onPeekError = () => socket.destroy();
      socket.once('error', onPeekError);
      socket.once('data', (firstChunk) => {
        socket.removeListener('error', onPeekError);
        socket.pause();
        const target = firstChunk[0] === 0x16 ? httpsServer : httpServer;
        socket.unshift(firstChunk);
        target.emit('connection', socket);
        process.nextTick(() => {
          if (!socket.destroyed) socket.resume();
        });
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

// Direct entrypoint execution
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  createAirBridgeServer()
    .then((instance) => {
      console.log(`\n${describeTlsSetup(instance).join('\n')}\n`);
    })
    .catch((err) => {
      console.error('Failed to start AirBridge server:', err);
      process.exit(1);
    });
}
