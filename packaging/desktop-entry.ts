/**
 * Single-file desktop app entry (macOS arm64/x64, Windows x64/arm64, Linux
 * x64/arm64/musl). Bundled with `bun build --compile` by
 * scripts/build-desktop.mjs:
 *
 *   - runs the AirBridge server in production mode,
 *   - serves the built UI embedded in the binary (packaging/clientAssets.json),
 *   - prints the phone QR + LAN addresses,
 *   - opens the local UI in the default browser,
 *   - `--install-startup` / `--uninstall-startup` register a per-user
 *     login item (LaunchAgent / HKCU Run key / autostart .desktop) —
 *     all without admin rights, root, or an Apple/MS developer account.
 *
 * Unlike bin/airbridge.mjs this file never falls back to `tsx` — it is
 * compiled from TypeScript sources directly by Bun, so the output binary has
 * zero runtime dependencies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import QRCode from 'qrcode';
import {
  createAirBridgeServer,
  describeTlsSetup,
  type AirBridgeServerOptions,
} from '../src/server/index.ts';
import { createCliBeamSession } from '../src/server/cliSendSession.ts';
import clientAssets from './clientAssets.json';
import pkg from '../package.json';

const APP_LABEL = 'com.airbridge.daemon';
const VERSION = pkg.version;

type StartupAction = 'install' | 'uninstall';

interface CliOptions {
  port: number;
  downloadDir?: string;
  reveal: boolean;
  https?: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  tlsDir?: string;
  noBrowser: boolean;
  action: StartupAction | null;
  subcommand: 'daemon' | 'send';
  sendFiles: string[];
  help: boolean;
  version: boolean;
}

function printHelp(): void {
  console.log(`
  ⚡ AirBridge ${VERSION} — native desktop build (single file, no Node required)

  Usage:
    airbridge [daemon] [options]          Start the AirBridge server
    airbridge send <file...> [options]    One-shot QR beam of files
    airbridge --install-startup           Auto-start at login (user-level, no admin)
    airbridge --uninstall-startup         Remove the auto-start entry

  Options:
    -p, --port <n>        Listen port (default 3000 or $PORT)
    -d, --dir <path>      Received-files folder (default ~/Downloads/AirBridge)
    --reveal              Open each received file in the file manager
    --http                Plain HTTP only (phone browsers need HTTPS — not recommended)
    --tls-cert <pem>      Use your own certificate (with --tls-key)
    --tls-key <pem>       Private key for --tls-cert
    --tls-dir <path>      Where the generated CA lives (default ~/.airbridge/tls)
    --no-browser          Do not open the local UI in a browser
    -h, --help            Show this help
    -v, --version         Show version
`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    port: Number.parseInt(process.env.PORT || '3000', 10),
    downloadDir: undefined,
    reveal: false,
    https: undefined,
    tlsCertPath: undefined,
    tlsKeyPath: undefined,
    tlsDir: undefined,
    noBrowser: false,
    action: null,
    subcommand: 'daemon',
    sendFiles: [],
    help: false,
    version: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-v' || arg === '--version') opts.version = true;
    else if ((arg === '-p' || arg === '--port') && argv[i + 1]) {
      opts.port = Number.parseInt(argv[++i], 10);
    } else if ((arg === '-d' || arg === '--dir') && argv[i + 1]) {
      opts.downloadDir = path.resolve(argv[++i]);
    } else if (arg === '--reveal') opts.reveal = true;
    else if (arg === '--http') opts.https = false;
    else if (arg === '--https') opts.https = true;
    else if (arg === '--tls-cert' && argv[i + 1]) opts.tlsCertPath = path.resolve(argv[++i]);
    else if (arg === '--tls-key' && argv[i + 1]) opts.tlsKeyPath = path.resolve(argv[++i]);
    else if (arg === '--tls-dir' && argv[i + 1]) opts.tlsDir = path.resolve(argv[++i]);
    else if (arg === '--no-browser') opts.noBrowser = true;
    else if (arg === '--install-startup') opts.action = 'install';
    else if (arg === '--uninstall-startup') opts.action = 'uninstall';
    else positional.push(arg);
  }

  if (positional[0] === 'daemon') {
    opts.subcommand = 'daemon';
    opts.sendFiles = positional.slice(1);
  } else if (positional[0] === 'send') {
    opts.subcommand = 'send';
    opts.sendFiles = positional.slice(1);
  } else if (positional.length > 0) {
    opts.subcommand = 'daemon';
    opts.sendFiles = positional;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Per-user login items (no admin, no developer accounts, no package manager)
// ---------------------------------------------------------------------------

function currentExecutable(): string {
  // process.execPath points at the compiled binary; argv[1] can differ when
  // invoked through a symlink, so prefer execPath and resolve it.
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function installStartup(opts: CliOptions): void {
  const exe = currentExecutable();
  const args = ['--no-browser'];
  if (opts.downloadDir) args.push('--dir', opts.downloadDir);
  if (opts.port !== 3000) args.push('--port', String(opts.port));

  if (process.platform === 'darwin') {
    const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const plistPath = path.join(agentsDir, `${APP_LABEL}.plist`);
    const argsXml = [`      <string>${escapeXml(exe)}</string>`]
      .concat(args.map((a) => `      <string>${escapeXml(a)}</string>`))
      .join('\n');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${APP_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(os.homedir(), 'Library', 'Logs', 'airbridge.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(os.homedir(), 'Library', 'Logs', 'airbridge.log'))}</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plist);
    runSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${APP_LABEL}`]);
    const loaded = runSync('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, plistPath]);
    if (loaded !== 0) runSync('launchctl', ['load', '-w', plistPath]);
    console.log(`✅ Auto-start installed (LaunchAgent): ${plistPath}`);
    console.log('   It starts the moment you log in — nothing runs for other users.');
    return;
  }

  if (process.platform === 'win32') {
    const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    const command = `"${exe}" ${args.join(' ')}`;
    const rc = runSync('reg', ['ADD', runKey, '/v', 'AirBridge', '/t', 'REG_SZ', '/d', command, '/f']);
    if (rc !== 0) throw new Error('reg.exe failed — is this an unpackaged/Store Python?');
    console.log('✅ Auto-start installed (HKCU Run — no admin required): AirBridge');
    return;
  }

  // Linux / other freesystems
  const autostartDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'autostart'
  );
  fs.mkdirSync(autostartDir, { recursive: true });
  const desktopPath = path.join(autostartDir, 'airbridge.desktop');
  fs.writeFileSync(
    desktopPath,
    `[Desktop Entry]
Type=Application
Name=AirBridge
Comment=AirBridge local file & clipboard bridge
Exec="${exe}" ${args.join(' ')}
Terminal=false
X-GNOME-Autostart-enabled=true
`
  );
  fs.chmodSync(desktopPath, 0o755);
  console.log(`✅ Auto-start installed (XDG autostart): ${desktopPath}`);
}

function uninstallStartup(): void {
  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${APP_LABEL}.plist`);
    runSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${APP_LABEL}`]);
    runSync('launchctl', ['unload', '-w', plistPath]);
    fs.rmSync(plistPath, { force: true });
    console.log('✅ Auto-start removed.');
    return;
  }
  if (process.platform === 'win32') {
    runSync('reg', [
      'DELETE',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      'AirBridge',
      '/f',
    ]);
    console.log('✅ Auto-start removed.');
    return;
  }
  const desktopPath = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'autostart',
    'airbridge.desktop'
  );
  fs.rmSync(desktopPath, { force: true });
  console.log('✅ Auto-start removed.');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function runSync(command: string, args: string[]): number {
  try {
    const res = spawnSync(command, args, { stdio: 'ignore', shell: false });
    return res.status ?? 1;
  } catch {
    return 1;
  }
}

function openInBrowser(url: string): void {
  let cmd: string;
  let cmdArgs: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    cmdArgs = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    cmdArgs = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    cmdArgs = [url];
  }
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // A browser may not exist (headless server) — the QR still works.
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (opts.version) {
    console.log(`airbridge ${VERSION}`);
    process.exit(0);
  }
  if (opts.action === 'install') {
    installStartup(opts);
    return;
  }
  if (opts.action === 'uninstall') {
    uninstallStartup();
    return;
  }

  const tlsOptions: Pick<
    AirBridgeServerOptions,
    'https' | 'tlsCertPath' | 'tlsKeyPath' | 'tlsDir'
  > = {};
  if (opts.https !== undefined) tlsOptions.https = opts.https;
  if (opts.tlsCertPath) tlsOptions.tlsCertPath = opts.tlsCertPath;
  if (opts.tlsKeyPath) tlsOptions.tlsKeyPath = opts.tlsKeyPath;
  if (opts.tlsDir) tlsOptions.tlsDir = opts.tlsDir;

  if (opts.subcommand === 'send') {
    if (opts.sendFiles.length === 0) {
      console.error('Error: specify at least one file. Example: airbridge send ./photo.jpg');
      process.exit(1);
    }
    const session = await createCliBeamSession(opts.sendFiles);
    const server = await createAirBridgeServer({
      port: 0,
      mode: 'production',
      clientAssets: clientAssets as Record<string, string>,
      cliSessions: new Map([[session.token, session]]),
      ...tlsOptions,
      onCliDownload: (fileName: string, ip: string) => {
        console.log(`  ✅ Delivered "${fileName}" to ${ip}`);
      },
    });
    const baseUrl = (server.lanUrls[0] || `http://127.0.0.1:${server.port}`).replace(
      /^https:/,
      'http:'
    );
    const directUrl =
      session.files.length === 1
        ? `${baseUrl}/api/beam/${session.token}/file/0`
        : `${baseUrl}/api/beam/${session.token}`;
    const qr = await QRCode.toString(directUrl, { type: 'terminal', small: true });
    console.log(`\n  ⚡ AirBridge Instant Beam (${VERSION}) ready`);
    console.log(`  📦 ${session.files.map((f) => f.name).join(', ')}`);
    console.log(`  📱 Scan with the Android camera:\n`);
    console.log(qr);
    console.log(`  URL: ${directUrl}\n  (Ctrl+C to stop)\n`);
    return;
  }

  // Default: daemon / app mode
  const server = await createAirBridgeServer({
    port: opts.port,
    mode: 'production',
    clientAssets: clientAssets as Record<string, string>,
    ...tlsOptions,
    daemonConfig: {
      enabled: true,
      autoSaveToDownloads: true,
      notifyOnReceive: true,
      revealInFinder: opts.reveal,
      ...(opts.downloadDir ? { downloadDir: opts.downloadDir } : {}),
    },
  });

  const targetUrl = server.lanUrls[0] || `http://localhost:${server.port}`;
  const localUrl = `http://localhost:${server.port}`;
  const qr = await QRCode.toString(targetUrl, { type: 'terminal', small: true });

  console.log(`\n  ⚡ AirBridge ${VERSION} active on port ${server.port}`);
  if (opts.downloadDir || process.env.AIRBRIDGE_DOWNLOAD_DIR) {
    console.log(`  📂 Auto-save folder: ${opts.downloadDir || process.env.AIRBRIDGE_DOWNLOAD_DIR}`);
  }
  for (const line of describeTlsSetup(server)) {
    console.log(`  ${line}`);
  }
  console.log(
    `  🤖 Native Android app: connect to ${targetUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/ws — no CA certificate install needed.`
  );
  console.log(`  🌐 Local UI: ${localUrl}\n`);
  console.log(`  📱 Scan on Android (${targetUrl}):\n`);
  console.log(qr);
  console.log('  (Ctrl+C to stop)\n');

  if (!opts.noBrowser) {
    setTimeout(() => openInBrowser(localUrl), 400);
  }
}

main().catch((err) => {
  console.error('AirBridge failed to start:', err);
  process.exit(1);
});
