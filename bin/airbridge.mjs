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
    -h, --help              Show this help message

  Examples:
    npx airbridge daemon --reveal
    npx airbridge send ./Demo-4K.mp4 ./Slides.pdf
`);
}

async function loadServerModules() {
  const compiledServer = path.join(rootDir, 'dist/server/server/index.js');
  const compiledCli = path.join(rootDir, 'dist/server/server/cliSendSession.js');
  if (fs.existsSync(compiledServer) && fs.existsSync(compiledCli)) {
    const srv = await import(compiledServer);
    const cli = await import(compiledCli);
    return { ...srv, ...cli };
  }
  // Fallback to tsx register when run directly from git checkout without prebuild
  const tsxApi = await import('tsx/esm/api');
  tsxApi.register();
  const srv = await import(path.join(rootDir, 'src/server/index.ts'));
  const cli = await import(path.join(rootDir, 'src/server/cliSendSession.ts'));
  return { ...srv, ...cli };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  let port = Number.parseInt(process.env.PORT || '3000', 10);
  let downloadDir = path.join(os.homedir(), 'Downloads', 'AirBridge');
  let revealInFinder = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '-p' || arg === '--port') && args[i + 1]) {
      port = Number.parseInt(args[++i], 10);
    } else if ((arg === '-d' || arg === '--dir') && args[i + 1]) {
      downloadDir = path.resolve(args[++i]);
    } else if (arg === '--reveal') {
      revealInFinder = true;
    } else {
      positional.push(arg);
    }
  }

  const subcommand = positional[0] || 'daemon';
  const { createAirBridgeServer, createCliBeamSession } = await loadServerModules();
  const hasBuiltClient = fs.existsSync(path.join(rootDir, 'dist/client/index.html'));
  const mode = hasBuiltClient ? 'production' : 'development';

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
      onCliDownload: (fileName, ip) => {
        console.log(`  ✅ Delivered "${fileName}" to ${ip}`);
      },
    });

    const baseUrl = server.lanUrls[0] || `http://127.0.0.1:${server.port}`;
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
  const server = await createAirBridgeServer({
    port,
    mode,
    daemonConfig: {
      enabled: true,
      downloadDir,
      autoSaveToDownloads: true,
      notifyOnReceive: true,
      revealInFinder,
    },
  });

  const targetUrl = server.lanUrls[0] || `http://localhost:${server.port}`;
  const qrAscii = await QRCode.toString(targetUrl, { type: 'terminal', small: true });

  console.log(`\n  ⚡ AirBridge Daemon Active on Port ${server.port}`);
  console.log(`  📂 Auto-Save Folder: ${downloadDir}`);
  console.log(`  💻 Open on MacBook:  http://localhost:${server.port}`);
  console.log(`  📱 Scan on Android (${targetUrl}):\n`);
  console.log(qrAscii);
}

main().catch((err) => {
  console.error('AirBridge CLI error:', err);
  process.exit(1);
});
