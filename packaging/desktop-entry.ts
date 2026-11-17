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
import { installLogCapture, recentLogs, startEventLoopMonitor } from '../src/server/diagnostics.ts';
import { CrashStore, beginRun, buildCrashReport, endRunCleanly, loadCrashDsn } from '../src/server/crashReports.ts';
import { Updater, appBundleForExecutable, confirmUpdateHealthy, isScriptRuntime, resolvePendingUpdate } from '../src/server/updater.ts';
import { emitShellEvent } from '../src/server/shellEvents.ts';
import { isShellPanel, panelUrl, probeRunningInstance, removeLinuxLauncher, writeLinuxLauncher, type ShellPanel } from '../src/server/desktopLauncher.ts';
import { DEFAULT_RELAY_PORT, RELAY_ENDPOINT_FILE, parseRelayEndpoint, startRelayServer } from '../src/server/relay.ts';
import clientAssets from './clientAssets.json';
import pkg from '../package.json';

const APP_LABEL = 'com.airbridge.daemon';
/** EX_TEMPFAIL: "restart me" for the macOS app, launchd and systemd supervisors. */
const RESTART_EXIT_STATUS = 75;

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
  subcommand: 'daemon' | 'send' | 'relay';
  /** `--relay host:port|off` (persisted for the login item). */
  relayEndpoint?: string;
  relayListen?: string;
  /** `--open [panel]`: open the local UI (a panel of it), reusing a running service. */
  openPanel?: ShellPanel | 'home';
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
    airbridge relay [--listen [host:]port] Run an AirBridge relay (VPS / always-on box)
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
    --open [panel]        Open the UI (contacts, calls, screen or settings);
                          hands off to an already-running AirBridge
    --relay <host:port>   Use this AirBridge relay when phones can't reach this
                          computer directly (saved; \`--relay off\` removes it).
                          Traffic stays end-to-end TLS; the relay sees ciphertext.
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
    else if (arg === '--relay' && argv[i + 1]) opts.relayEndpoint = argv[++i];
    else if (arg === '--listen' && argv[i + 1]) opts.relayListen = argv[++i];
    else if (arg === '--open') {
      opts.openPanel = isShellPanel(argv[i + 1]) ? (argv[++i] as ShellPanel) : 'home';
    } else if (arg === '--install-startup') opts.action = 'install';
    else if (arg === '--uninstall-startup') opts.action = 'uninstall';
    else positional.push(arg);
  }

  if (positional[0] === 'daemon') {
    opts.subcommand = 'daemon';
    opts.sendFiles = positional.slice(1);
  } else if (positional[0] === 'relay') {
    opts.subcommand = 'relay';
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
  installLinuxLauncher(exe, opts);
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
  removeLinuxLauncher();
  console.log('✅ Auto-start removed.');
}

/** Linux app launcher (top bar / dock / app grid) with the version + panel actions. */
function launcherArgs(opts: Pick<CliOptions, 'port'>): string[] {
  return opts.port !== 3000 ? ['--port', String(opts.port)] : [];
}

function installLinuxLauncher(exe: string, opts: CliOptions): void {
  try {
    const file = writeLinuxLauncher({ executable: exe, version: VERSION, extraArgs: launcherArgs(opts), install: true });
    if (file) console.log(`✅ App launcher installed (Contacts, Calls, Screen Sharing): ${file}`);
  } catch (err) {
    console.warn(`[airbridge] could not write the app launcher: ${(err as Error).message}`);
  }
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
  if (opts.relayEndpoint) {
    const file = path.join(opts.tlsDir ? path.dirname(opts.tlsDir) : path.join(os.homedir(), '.airbridge'), RELAY_ENDPOINT_FILE);
    if (opts.relayEndpoint === 'off') {
      fs.rmSync(file, { force: true });
      console.log('Relay fallback disabled.');
    } else {
      const parsed = parseRelayEndpoint(opts.relayEndpoint);
      if (!parsed) {
        console.error(`Error: --relay expects host:port, got "${opts.relayEndpoint}"`);
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${parsed.endpoint}\n`);
      console.log(`Relay fallback: ${parsed.endpoint} (saved)`);
    }
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

  if (opts.subcommand === 'relay') {
    const listen = opts.relayListen ?? String(DEFAULT_RELAY_PORT);
    const m = /^(?:(.+):)?(\d{1,5})$/.exec(listen);
    if (!m) {
      console.error('Error: --listen expects [host:]port');
      process.exit(1);
    }
    const relay = await startRelayServer({
      host: m[1]?.replace(/^\[|\]$/g, '') || '::',
      port: Number(m[2]),
      log: (line) => console.log(line),
    });
    console.log(`Point computers at it with:  airbridge --relay <this-host>:${relay.port}`);
    const stop = () => { void relay.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    setInterval(() => {
      const s = relay.stats();
      console.log(`relay: ${s.rooms} computers, ${s.standby} standby, ${s.splices} active, ${(s.bytes / 1048576).toFixed(1)} MiB relayed`);
    }, 10 * 60_000).unref();
    return;
  }

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
  const openPanel = opts.openPanel === 'home' ? null : (opts.openPanel ?? null);
  if (opts.openPanel) {
    // Launcher / menu action: if AirBridge already runs, just show the panel.
    const running = await probeRunningInstance(opts.port);
    if (running) {
      openInBrowser(panelUrl(running.url, openPanel));
      return;
    }
  }
  const stateDir = path.join(os.homedir(), '.airbridge');
  fs.mkdirSync(stateDir, { recursive: true });
  const crashStore = new CrashStore(path.join(stateDir, 'crashes'));
  installDaemonSafetyNets(crashStore);
  // A previous run that never shut down cleanly (native crash, out of
  // memory, killed by the watchdog) becomes a local crash report.
  const previousCrash = beginRun(stateDir, crashStore, VERSION);
  if (previousCrash) console.warn(`[airbridge] the previous run ended unexpectedly; a crash report is ready to review (${previousCrash.id})`);
  process.on('exit', (code) => {
    if (code === 0 || code === RESTART_EXIT_STATUS) endRunCleanly(stateDir);
  });
  // A just-installed update that keeps failing to come up is rolled back here.
  const pending = resolvePendingUpdate(stateDir, VERSION);
  if (pending === 'rolled-back') {
    process.exit(RESTART_EXIT_STATUS); // the supervisor (or the user) starts the restored build
  }
  // Only the compiled single-file release binary self-updates: the committed
  // clientAssets.json stub has a single placeholder page, and under node/bun/tsx
  // process.execPath is the runtime itself (which must never be replaced).
  const isPackagedBinary = Object.keys(clientAssets as object).length > 1 && !isScriptRuntime(process.execPath);
  let restartAfterUpdate: (() => void) | null = null;
  const updater = isPackagedBinary && process.env.AIRBRIDGE_AUTO_UPDATE !== '0'
    ? new Updater({
        currentVersion: VERSION,
        stateDir,
        executablePath: process.execPath,
        appBundlePath: appBundleForExecutable(process.execPath),
        onInstalled: (info) => {
          // Let the macOS app relaunch from the new bundle (it must not stop
          // the service on its way out).
          emitShellEvent({ type: 'update-installed', version: info.version, relaunch: info.appBundle }, 'lifecycle');
          setTimeout(() => restartAfterUpdate?.(), 500);
        },
      })
    : null;
  const server = await createAirBridgeServer({
    port: opts.port,
    mode: 'production',
    version: VERSION,
    updater,
    crashStore,
    crashDsn: loadCrashDsn(stateDir),
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
  // The QR embeds this session's default pair code so the phone lands inside
  // the host's pairing group on first open (?pair= handled by the client).
  const pairCode = server.hub?.getDefaultPairCode?.() || '';
  const connectUrl = pairCode
    ? `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}pair=${pairCode}`
    : targetUrl;
  const qr = await QRCode.toString(connectUrl, { type: 'terminal', small: true });

  console.log(`\n  ⚡ AirBridge ${VERSION} active on port ${server.port}`);
  if (opts.downloadDir || process.env.AIRBRIDGE_DOWNLOAD_DIR) {
    console.log(`  📂 Auto-save folder: ${opts.downloadDir || process.env.AIRBRIDGE_DOWNLOAD_DIR}`);
  }
  for (const line of describeTlsSetup(server)) {
    console.log(`  ${line}`);
  }
  console.log(
    `  🤖 Android app: scan the QR below, or enter ${targetUrl} in the app — no CA certificate install needed.`
  );
  console.log(`  🌐 Local UI: ${localUrl}`);
  console.log(`  📦 More builds + this machine's files: ${localUrl.replace(/^http:/, targetUrl.startsWith('https') ? 'https:' : 'http:')}`);
  console.log(`  🖥  No build for your OS? The CLI runs anywhere Node 20+ exists: npx airbridge\n`);
  console.log(`  📱 Scan on Android — the QR auto-pairs (${connectUrl}):\n`);
  console.log(qr);
  const httpBase = targetUrl.replace(/^https:/, 'http:');
  console.log(`  🔗 Open: ${connectUrl}`);
  console.log(`  🔐 Phone browser warning? Install the CA once: ${httpBase}/airbridge-ca.crt`);
  console.log('     (check the fingerprint above first), then rescan.');
  console.log('  (Ctrl+C to stop)\n');

  if (!opts.noBrowser || opts.openPanel) {
    setTimeout(() => openInBrowser(panelUrl(localUrl, openPanel)), 400);
  }
  if (process.platform === 'linux' && isPackagedBinary) {
    // Keep an installed launcher's version + path current (self-updates).
    try {
      writeLinuxLauncher({ executable: currentExecutable(), version: VERSION, extraArgs: launcherArgs(opts) });
    } catch { /* read-only home: the launcher just keeps its old version text */ }
  }

  if (pending === 'pending') {
    // Healthy for a minute: the update is confirmed and the backup kept for manual rollback.
    setTimeout(() => confirmUpdateHealthy(stateDir), 60_000).unref();
  }
  restartAfterUpdate = () => {
    void server.close().catch(() => {}).finally(() => {
      // The macOS app, launchd (KeepAlive SuccessfulExit=false) and systemd
      // (Restart=on-failure) restart the service on this "restart me" status.
      if (process.env.AIRBRIDGE_SUPERVISED) process.exit(RESTART_EXIT_STATUS);
      // Unsupervised: start the new build ourselves with the same arguments.
      const child = spawn(process.execPath, process.argv.slice(2), {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
      process.exit(0);
    });
  };
  updater?.start();

  // Quitting (Ctrl+C, the macOS app, launchctl/systemctl stop) is a clean
  // shutdown, not a crash. A hung process cannot run this and is SIGKILLed
  // by its supervisor, so that case is still reported at the next start.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    endRunCleanly(stateDir);
    setTimeout(() => process.exit(0), 3_000).unref();
    void server.close().catch(() => {}).finally(() => process.exit(0));
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, shutdown);
}

/**
 * Long-running service hardening:
 *  - an uncaught error in one connection/helper is logged with its stack and
 *    the service keeps serving (a crash would drop every device and, under the
 *    macOS app, look like "AirBridge keeps restarting"). A burst of errors
 *    still exits so the supervisor can start a clean process.
 *  - event-loop stalls are logged, so anything that blocks /api/health is
 *    visible in ~/.airbridge/server.log instead of a silent restart.
 */
function installDaemonSafetyNets(crashStore: CrashStore): void {
  const recent: number[] = [];
  const startedAt = Date.now();
  const onFatal = (kind: 'uncaught exception' | 'unhandled rejection') => (err: unknown) => {
    const now = Date.now();
    recent.push(now);
    while (recent.length && now - recent[0]! > 60_000) recent.shift();
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`[airbridge] ${new Date().toISOString()} ${kind}: ${detail}`);
    try {
      crashStore.recordSync(buildCrashReport(err, kind === 'uncaught exception' ? 'uncaught-exception' : 'unhandled-rejection', {
        version: VERSION,
        startedAt,
        logTail: recentLogs(80).map((l) => `${l.t} ${l.level} ${l.msg}`),
      }));
    } catch {
      // Reporting must never make a crash worse.
    }
    if (recent.length > 20) {
      console.error('[airbridge] too many unexpected errors in one minute; exiting for a clean restart');
      // Already reported above; do not add an "ended unexpectedly" report too.
      endRunCleanly(path.join(os.homedir(), '.airbridge'));
      process.exit(70);
    }
  };
  process.on('uncaughtException', onFatal('uncaught exception'));
  process.on('unhandledRejection', onFatal('unhandled rejection'));
  process.stdout.on?.('error', () => {});
  process.stderr.on?.('error', () => {});

  installLogCapture();
  startEventLoopMonitor(2_000);
}

main().catch((err) => {
  console.error('AirBridge failed to start:', err);
  process.exit(1);
});
