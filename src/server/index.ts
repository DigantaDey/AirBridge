import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { SignalingHub } from './signalingHub.js';
import { getLanUrls, startMdnsResponder, type MdnsHandle } from './mdnsService.js';
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
}

export interface AirBridgeServerInstance {
  app: Express;
  httpServer: http.Server;
  hub: SignalingHub;
  port: number;
  lanUrls: string[];
  close: () => Promise<void>;
}

export async function createAirBridgeServer(
  options: AirBridgeServerOptions = {}
): Promise<AirBridgeServerInstance> {
  const mode =
    options.mode ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  const host = options.host ?? '0.0.0.0';
  const requestedPort = options.port ?? Number.parseInt(process.env.PORT || '3000', 10);

  const daemonCfg = createMacDaemonConfig(options.daemonConfig);
  const cliSessions = options.cliSessions ?? new Map<string, CliBeamSession>();

  const app = express();
  app.disable('x-powered-by');

  const httpServer = http.createServer(app);
  let activePort = requestedPort;
  let mdns: MdnsHandle | null = null;

  const hub = new SignalingHub({
    getLanUrls: () => getLanUrls(activePort),
    getDaemonStatus: () => getDaemonStatus(daemonCfg),
  });

  // Health & runtime diagnostics endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'AirBridge Warp Server',
      protocol: 'warp-v1',
      e2ee: 'ECDH-P256-AES-256-GCM',
      uptimeSec: Math.round(process.uptime()),
      ...hub.getStats(),
      lanUrls: getLanUrls(activePort),
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

  // Attach WebSocket upgrade strictly for /ws (leaving Vite HMR upgrades untouched)
  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/ws') {
        hub.wss.handleUpgrade(req, socket, head, (ws) => {
          hub.wss.emit('connection', ws, req);
        });
      }
    } catch {
      socket.destroy();
    }
  });

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

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, host, () => {
      const addr = httpServer.address();
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
    hub,
    port: activePort,
    lanUrls: getLanUrls(activePort),
    async close() {
      mdns?.close();
      hub.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

// Direct entrypoint execution
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  createAirBridgeServer()
    .then((instance) => {
      const lanList = instance.lanUrls.length > 0 ? instance.lanUrls.join(', ') : 'none detected';
      console.log(`\n⚡ AirBridge Warp Server listening on http://0.0.0.0:${instance.port}`);
      console.log(`📡 Local Wi-Fi LAN URLs: ${lanList}\n`);
    })
    .catch((err) => {
      console.error('Failed to start AirBridge server:', err);
      process.exit(1);
    });
}
