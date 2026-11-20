#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function printHelp() {
  console.log(`
  ⚡ AirBridge CLI — Open-Source Android ↔ MacBook AirDrop

  Usage:
    airbridge [daemon] [options]         Start AirBridge server + direct ~/Downloads auto-save
    airbridge send <file...> [options]   Beam file(s) from terminal to Android via instant QR

  Options:
    -p, --port <number>     Port to listen on (default: 3000)
    -d, --dir <path>        Auto-save directory (default: ~/Downloads/AirBridge)
    --reveal                Auto-reveal received files in macOS Finder
    --http                  Plain HTTP only (NOT recommended: phone browsers block
                            WebCrypto on Wi-Fi addresses; HTTPS is on by default)
    --tls-cert <path>       PEM certificate to serve instead of the generated
                            local CA's (e.g. mkcert). Requires --tls-key.
    --tls-key <path>        PEM private key for --tls-cert
    --tls-dir <path>        Where the generated local CA lives
                            (default: ~/.airbridge/tls)
    -h, --help              Show this help message

  Examples:
    npx airbridge daemon --reveal
    npx airbridge send ./Demo-4K.mp4 ./Slides.pdf
`);
}

async function loadServerModules() {
  const compiledServer = path.join(rootDir, 'dist/server/server/index.js');
  const compiledCli = path.join(rootDir, 'dist/server/server/cliSendSession.js');
  const compiledCrash = path.join(rootDir, 'dist/server/server/crashReports.js');
  const compiledDiag = path.join(rootDir, 'dist/server/server/diagnostics.js');
  if (fs.existsSync(compiledServer) && fs.existsSync(compiledCli)) {
    const srv = await import(compiledServer);
    const cli = await import(compiledCli);
    const crash = fs.existsSync(compiledCrash) ? await import(compiledCrash) : {};
    const diag = fs.existsSync(compiledDiag) ? await import(compiledDiag) : {};
    return { ...srv, ...cli, ...crash, ...diag };
  }
  // Fallback to tsx register when run directly from git checkout without prebuild
  const tsxApi = await import('tsx/esm/api');
  tsxApi.register();
  const srv = await import(path.join(rootDir, 'src/server/index.ts'));
  const cli = await import(path.join(rootDir, 'src/server/cliSendSession.ts'));
  const crash = await import(path.join(rootDir, 'src/server/crashReports.ts'));
  const diag = await import(path.join(rootDir, 'src/server/diagnostics.ts'));
  return { ...srv, ...cli, ...crash, ...diag };
}

function validatePort(raw, source = '--port') {
  const n = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(String(raw).trim()) || !Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`Error: ${source} must be an integer between 1 and 65535 (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  let port = process.env.PORT ? validatePort(process.env.PORT, 'PORT') : 3000;
  let downloadDir = path.join(os.homedir(), 'Downloads', 'AirBridge');
  let revealInFinder = false;
  // Left undefined unless flagged so the server default (HTTPS on) applies.
  const tlsOptions = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-p' || arg === '--port') {
      if (!args[i + 1]) {
        console.error('Error: --port requires a port number (1..65535)');
        process.exit(1);
      }
      port = validatePort(args[++i], '--port');
    } else if ((arg === '-d' || arg === '--dir') && args[i + 1]) {
      downloadDir = path.resolve(args[++i]);
    } else if (arg === '--reveal') {
      revealInFinder = true;
    } else if (arg === '--http') {
      tlsOptions.https = false;
    } else if (arg === '--https') {
      tlsOptions.https = true;
    } else if (arg === '--tls-cert' && args[i + 1]) {
      tlsOptions.tlsCertPath = args[++i];
    } else if (arg === '--tls-key' && args[i + 1]) {
      tlsOptions.tlsKeyPath = args[++i];
    } else if (arg === '--tls-dir' && args[i + 1]) {
      tlsOptions.tlsDir = args[++i];
    } else {
      positional.push(arg);
    }
  }

  const subcommand = positional[0] || 'daemon';
  const {
    buildTerminalPairingUrl,
    createAirBridgeServer,
    createCliBeamSession,
    describeTlsSetup,
    CrashStore,
    beginRun,
    buildCrashReport,
    endRunCleanly,
    loadCrashDsn,
    installLogCapture,
    recentLogs,
    startEventLoopMonitor,
  } = await loadServerModules();
  const hasBuiltClient = fs.existsSync(path.join(rootDir, 'dist/client/index.html'));
  const mode = hasBuiltClient ? 'production' : 'development';
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const version = pkgJson.version || 'dev';

  if (typeof installLogCapture === 'function') installLogCapture();
  if (typeof startEventLoopMonitor === 'function') startEventLoopMonitor(2_000);

  if (subcommand === 'send') {
    const fileArgs = positional.slice(1);
    if (fileArgs.length === 0) {
      console.error('Error: Specify at least one file to send. Example: airbridge send ./photo.jpg');
      process.exit(1);
    }

    const session = await createCliBeamSession(fileArgs);
    const sessions = new Map([[session.token, session]]);

    const server = await createAirBridgeServer({
      port: 0,
      mode,
      cliSessions: sessions,
      ...tlsOptions,
      onCliDownload: (fileName, ip) => {
        console.log(`  ✅ Delivered "${fileName}" to ${ip}`);
      },
    });

    // Beam links are one-purpose token downloads that need no secure-context
    // browser APIs, so keep the QR on plain HTTP (the server still accepts
    // HTTPS on the same port for anyone who prefers it) — scanning it must
    // not interrupt a simple file download with a certificate warning.
    const baseUrl = (server.lanUrls[0] || `http://127.0.0.1:${server.port}`).replace(
      /^https:/,
      'http:'
    );
    const directUrl =
      session.files.length === 1
        ? `${baseUrl}/api/beam/${session.token}/file/0`
        : `${baseUrl}/api/beam/${session.token}`;

    const qrAscii = await QRCode.toString(directUrl, { type: 'terminal', small: true });
    console.log('\n  ⚡ AirBridge Instant Terminal Beam Ready!');
    console.log(`  📦 Files (${session.files.length}): ${session.files.map((f) => f.name).join(', ')}`);
    console.log(`  🔗 Scan with your Android camera to download over Wi-Fi:\n`);
    console.log(qrAscii);
    console.log(`  URL: ${directUrl}\n  (Press Ctrl+C when finished)\n`);
    return;
  }

  // Default: daemon mode
  const stateDir = path.join(os.homedir(), '.airbridge');
  fs.mkdirSync(stateDir, { recursive: true });
  const crashStore = typeof CrashStore === 'function' ? new CrashStore(path.join(stateDir, 'crashes')) : null;
  if (crashStore && typeof beginRun === 'function') {
    beginRun(stateDir, crashStore, version);
    const startedAt = Date.now();
    const recordFatal = (kind) => (err) => {
      try {
        crashStore.recordSync(
          buildCrashReport(err, kind, {
            version,
            startedAt,
            logTail: typeof recentLogs === 'function' ? recentLogs(80).map((l) => `${l.t} ${l.level} ${l.msg}`) : [],
          }),
        );
      } catch {
        // ignore
      }
    };
    process.on('uncaughtException', recordFatal('uncaught-exception'));
    process.on('unhandledRejection', recordFatal('unhandled-rejection'));
    process.on('exit', (code) => {
      if (code === 0 && typeof endRunCleanly === 'function') endRunCleanly(stateDir);
    });
  }

  let server;
  try {
    server = await createAirBridgeServer({
      port,
      mode,
      version,
      crashStore,
      crashDsn: typeof loadCrashDsn === 'function' ? loadCrashDsn(stateDir) : null,
      ...tlsOptions,
      daemonConfig: {
        enabled: true,
        downloadDir,
        autoSaveToDownloads: true,
        notifyOnReceive: true,
        revealInFinder,
      },
    });
  } catch (err) {
    if (typeof endRunCleanly === 'function') endRunCleanly(stateDir);
    throw err;
  }

  const targetUrl = server.lanUrls[0] || `http://localhost:${server.port}`;
  // The QR embeds this session's default pair code, TLS anchor pin, and alternate LAN IPs:
  // the phone opens the page already inside the host's pairing group.
  const connectUrl = typeof buildTerminalPairingUrl === 'function'
    ? buildTerminalPairingUrl(server)
    : (() => {
        const pairCode = server.hub?.getDefaultPairCode?.() || '';
        return pairCode ? `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}pair=${pairCode}` : targetUrl;
      })();
  const qrAscii = await QRCode.toString(connectUrl, { type: 'terminal', small: true });

  console.log(`\n  ⚡ AirBridge Daemon Active on Port ${server.port}`);
  console.log(`  📂 Auto-Save Folder: ${downloadDir}`);
  for (const line of describeTlsSetup(server)) {
    console.log(`  ${line}`);
  }
  console.log(`  🌐 Any other OS? This CLI also runs anywhere Node 20+ exists: npx airbridge`);
  console.log(`  📱 Scan on Android — the QR auto-pairs (${connectUrl}):\n`);
  console.log(qrAscii);
  const httpBase = targetUrl.replace(/^https:/, 'http:');
  console.log(`  🔗 Open: ${connectUrl}`);
  console.log(`  🔐 Phone browser warning? Install the CA once: ${httpBase}/airbridge-ca.crt`);
  console.log('     (verify the fingerprint above before installing), then rescan.\n');
  const shutdown = () => {
    if (typeof endRunCleanly === 'function') endRunCleanly(stateDir);
    void server.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGHUP', shutdown);
}

main().catch((err) => {
  console.error('AirBridge CLI error:', err);
  process.exit(1);
});
