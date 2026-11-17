import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = path.resolve('install.sh');
let root: string;
let home: string;
let mocks: string;
let env: NodeJS.ProcessEnv;

function mock(name: string, script: string) {
  fs.writeFileSync(path.join(mocks, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
}
function run(command: string, args: string[] = []) {
  return spawnSync(command, args, { env, encoding: 'utf8', timeout: 15000 });
}
function install(...args: string[]) { return run('bash', [installer, ...args]); }
function appFile(...parts: string[]) { return path.join(home, 'Applications/AirBridge.app/Contents', ...parts); }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge mac test '));
  home = path.join(root, 'home & user');
  mocks = path.join(root, 'mocks');
  fs.mkdirSync(home); fs.mkdirSync(mocks);
  env = { ...process.env, HOME: home, PATH: `${mocks}:${process.env.PATH}`, AIRBRIDGE_INSTALL_DIR: path.join(home, 'my bin'), PORT: '3105', TEST_ROOT: root, AIRBRIDGE_NATIVE_APP: '0' };
  mock('uname', 'if [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi');
  mock('codesign', 'exit 0');
  mock('curl', `
url="\${!#}"
case "$url" in
  */api/health) [ -f "$TEST_ROOT/ready" ] && echo '{"service":"AirBridge Warp Server"}' || exit 1 ;;
  *SHA256SUMS*) exit 22 ;;
  *AirBridge.icns) cp "$TEST_ROOT/icon" "$4" ;;
  *) cat > "$4" <<'BIN'
#!/bin/bash
if [ "$1" = --version ]; then echo 1.0; exit 0; fi
echo "$PORT $*" >> "$TEST_ROOT/starts"
touch "$TEST_ROOT/ready"
BIN
  ;;
esac`);
  // fetch's -o is not always argument 4; extract the output path instead.
  const curlPath = path.join(mocks, 'curl');
  let curl = fs.readFileSync(curlPath, 'utf8');
  curl = curl.replace('url="${!#}"', 'url="${!#}"\nout=""\nfor ((i=1;i<=$#;i++)); do if [ "${!i}" = -o ]; then j=$((i+1)); out="${!j}"; fi; done').replaceAll('"$4"', '"$out"');
  fs.writeFileSync(curlPath, curl);
  fs.writeFileSync(path.join(root, 'icon'), 'icon data');
  mock('open', 'echo "$*" >> "$TEST_ROOT/opened"');
  mock('osascript', 'cat >/dev/null; echo "$*" >> "$TEST_ROOT/dialog"');
  mock('sleep', ':');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('macOS installer', () => {
  it('installs a Launchpad app and reuses the server on subsequent opens', () => {
    const result = install('--no-start');
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(appFile('Info.plist'), 'utf8')).toContain('com.airbridge.launcher');
    expect(fs.readFileSync(appFile('Resources/AirBridge.icns'), 'utf8')).toBe('icon data');
    const launcher = appFile('MacOS/AirBridge');
    expect(run(launcher).status).toBe(0);
    expect(run(launcher).status).toBe(0);
    expect(fs.readFileSync(path.join(root, 'starts'), 'utf8').trim()).toBe('3105 --no-browser');
    expect(fs.readFileSync(path.join(root, 'opened'), 'utf8').trim().split('\n')).toEqual(['http://localhost:3105', 'http://localhost:3105']);
    expect(install('--no-start').status).toBe(0);
  }, 15_000);
  it('shows an error instead of opening an unrelated service or missing binary', () => {
    expect(install('--no-start').status).toBe(0);
    fs.rmSync(path.join(env.AIRBRIDGE_INSTALL_DIR!, 'AirBridge'));
    expect(run(appFile('MacOS/AirBridge')).status).toBe(1);
    expect(fs.readFileSync(path.join(root, 'dialog'), 'utf8')).toContain('could not be found');
    expect(fs.existsSync(path.join(root, 'opened'))).toBe(false);
  });
  it('reports a port conflict rather than opening another service', () => {
    expect(install('--no-start').status).toBe(0);
    mock('curl', `echo '{"service":"something else"}'`);
    fs.writeFileSync(path.join(env.AIRBRIDGE_INSTALL_DIR!, 'AirBridge'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    expect(run(appFile('MacOS/AirBridge')).status).toBe(1);
    expect(fs.readFileSync(path.join(root, 'dialog'), 'utf8')).toContain('could not start on port 3105');
    expect(fs.existsSync(path.join(root, 'opened'))).toBe(false);
  });
  it('opens the app by default after installation', () => {
    expect(install().status).toBe(0);
    expect(fs.readFileSync(path.join(root, 'opened'), 'utf8').trim()).toBe(path.join(home, 'Applications/AirBridge.app'));
  });
  it('does not overwrite an unrelated application', () => {
    fs.mkdirSync(appFile(''), { recursive: true });
    const result = install('--no-start');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not replacing it');
  });
  it('writes a valid escaped login item with the configured port', () => {
    mock('launchctl', 'exit 0');
    expect(install('--no-start', '--autostart').status).toBe(0);
    const plist = fs.readFileSync(path.join(home, 'Library/LaunchAgents/com.airbridge.daemon.plist'), 'utf8');
    expect(plist).toContain('home &amp; user');
    expect(plist).toContain('<string>--port</string><string>3105</string>');
    expect(plist).toContain('<key>PORT</key><string>3105</string>');
  });
  it('supports source installs when Finder cannot find Node on PATH', () => {
    mock('git', 'mkdir -p "$HOME/.local/share/airbridge/src/.git"');
    mock('npm', 'mkdir -p "$HOME/.local/share/airbridge/src/dist/server/server"; touch "$HOME/.local/share/airbridge/src/dist/server/server/index.js"');
    mock('node', `if [ "$1" = -p ]; then echo 22; else printf '%s\\n' "$@" > "$TEST_ROOT/node-args"; fi`);
    const result = install('--from-source', '--no-start');
    expect(result.status, result.stderr).toBe(0);
    const binary = path.join(env.AIRBRIDGE_INSTALL_DIR!, 'AirBridge');
    const launched = spawnSync(binary, ['--no-browser', 'with spaces'], { env: { ...env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(launched.status, launched.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, 'node-args'), 'utf8').trim().split('\n')).toEqual([
      path.join(home, '.local/share/airbridge/src/dist/server/server/index.js'), '--no-browser', 'with spaces',
    ]);
  });
  it('does not install a macOS app on Linux', () => {
    mock('uname', 'if [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi');
    expect(install('--no-start').status).toBe(0);
    expect(fs.existsSync(appFile('Info.plist'))).toBe(false);
  });
  it('rejects invalid ports before installation', () => {
    env.PORT = 'abc';
    expect(install('--no-start').stderr).toContain('PORT must be');
  });

  it('stops an old AirBridge server still holding the port (any install path), but nothing else', async () => {
    const { spawn } = await import('node:child_process');
    // Real processes: an "older AirBridge" from another location and an unrelated program.
    const oldDir = path.join(root, 'old install');
    fs.mkdirSync(oldDir);
    const oldBin = path.join(oldDir, 'airbridge-legacy');
    fs.writeFileSync(oldBin, '#!/bin/bash\nexec /bin/sleep 60\n', { mode: 0o755 });
    const other = path.join(root, 'other-server');
    fs.writeFileSync(other, '#!/bin/bash\nexec /bin/sleep 60\n', { mode: 0o755 });
    const old = spawn('bash', ['-c', `exec -a "${oldBin} --port 3105" /bin/sleep 60`], { stdio: 'ignore' });
    const foreign = spawn('bash', ['-c', 'exec -a "python3 -m http.server 3105" /bin/sleep 60'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      mock('lsof', `echo ${old.pid}; echo ${foreign.pid}`);
      mock('pgrep', 'exit 1');
      mock('launchctl', 'echo "$*" >> "$TEST_ROOT/launchctl"');
      const result = install('--no-start');
      expect(result.status, result.stderr).toBe(0);
      await new Promise((r) => setTimeout(r, 200));
      expect(old.exitCode !== null || old.signalCode !== null).toBe(true);
      expect(foreign.exitCode).toBeNull();
      expect(foreign.signalCode).toBeNull();
    } finally {
      old.kill('SIGKILL');
      foreign.kill('SIGKILL');
    }
  });

  describe('prebuilt AirBridge.app', () => {
    function prebuilt(sumsMatch: boolean) {
      // A release zip (contents are what the ditto mock "extracts").
      const payload = path.join(root, 'zip-payload', 'AirBridge.app', 'Contents');
      fs.mkdirSync(path.join(payload, 'MacOS'), { recursive: true });
      fs.mkdirSync(path.join(payload, 'Resources'), { recursive: true });
      fs.writeFileSync(path.join(payload, 'Info.plist'), '<key>CFBundleIdentifier</key><string>com.airbridge.launcher</string>');
      fs.writeFileSync(path.join(payload, 'MacOS', 'AirBridge'), '\xCF\xFA\xED\xFE mach-o', { mode: 0o755 });
      fs.writeFileSync(path.join(payload, 'Resources', 'airbridge-server'), '#!/bin/bash\nif [ "$1" = --version ]; then echo "airbridge 9.9.9"; exit 0; fi\n', { mode: 0o755 });
      fs.writeFileSync(path.join(root, 'release.zip'), 'zip bytes');
      const zipSha = spawnSync('sha256sum', [path.join(root, 'release.zip')], { encoding: 'utf8' }).stdout.split(' ')[0];
      fs.writeFileSync(path.join(root, 'sums'), `${sumsMatch ? zipSha : '0'.repeat(64)}  AirBridge-macOS-arm64.zip\n`);
      let curl = fs.readFileSync(path.join(mocks, 'curl'), 'utf8');
      curl = curl
        .replace('*SHA256SUMS*) exit 22 ;;', '*SHA256SUMS*) cp "$TEST_ROOT/sums" "$out" ;;\n  *AirBridge-macOS-arm64.zip) cp "$TEST_ROOT/release.zip" "$out" ;;');
      fs.writeFileSync(path.join(mocks, 'curl'), curl);
      mock('ditto', 'cp -R "$TEST_ROOT/zip-payload/." "${@: -1}/"');
      mock('shasum', 'sha256sum "${@: -1}"');
    }

    it('installs the verified prebuilt app and points the CLI at its embedded service', () => {
      prebuilt(true);
      const result = install('--no-start');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('prebuilt, signature verified');
      expect(fs.existsSync(appFile('Resources', 'airbridge-server'))).toBe(true);
      // Nothing written into the signed bundle; settings live in ~/.airbridge.
      expect(fs.existsSync(appFile('Resources', 'port'))).toBe(false);
      expect(fs.readFileSync(path.join(home, '.airbridge/port'), 'utf8').trim()).toBe('3105');
      const cli = path.join(env.AIRBRIDGE_INSTALL_DIR!, 'AirBridge');
      expect(fs.lstatSync(cli).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(cli)).toBe(appFile('Resources', 'airbridge-server'));
      // Re-installing replaces the link, never the file inside the bundle.
      expect(install('--no-start').status).toBe(0);
      expect(fs.readFileSync(appFile('Resources', 'airbridge-server'), 'utf8')).toContain('airbridge 9.9.9');
    });

    it('refuses a prebuilt app whose checksum does not match and builds the app locally', () => {
      prebuilt(false);
      const result = install('--no-start');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('checksum mismatch for AirBridge-macOS-arm64.zip');
      expect(fs.existsSync(appFile('Resources', 'airbridge-server'))).toBe(false);
      expect(fs.lstatSync(path.join(env.AIRBRIDGE_INSTALL_DIR!, 'AirBridge')).isSymbolicLink()).toBe(false);
    });

    it('registers the native app (not a bare server) as the restartable login item', () => {
      prebuilt(true);
      mock('launchctl', 'echo "$*" >> "$TEST_ROOT/launchctl"');
      expect(install('--no-start', '--autostart').status).toBe(0);
      const plist = fs.readFileSync(path.join(home, 'Library/LaunchAgents/com.airbridge.app.plist'), 'utf8');
      expect(plist).toContain('Contents/MacOS/AirBridge</string><string>--background</string>');
      expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
      expect(plist).toContain('<key>ThrottleInterval</key><integer>10</integer>');
      expect(fs.existsSync(path.join(home, 'Library/LaunchAgents/com.airbridge.daemon.plist'))).toBe(false);
    });
  });

  it('the server login item restarts after crashes and updates (exit 75), not after a clean exit', () => {
    mock('launchctl', 'exit 0');
    expect(install('--no-start', '--autostart').status).toBe(0);
    const plist = fs.readFileSync(path.join(home, 'Library/LaunchAgents/com.airbridge.daemon.plist'), 'utf8');
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(plist).toContain('<key>AIRBRIDGE_SUPERVISED</key><string>launchd</string>');
  });

  it('Linux autostart uses a systemd user service when available', () => {
    mock('uname', 'if [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi');
    mock('systemctl', 'echo "$*" >> "$TEST_ROOT/systemctl"');
    const result = install('--autostart');
    expect(result.status, result.stderr).toBe(0);
    const unit = fs.readFileSync(path.join(home, '.config/systemd/user/airbridge.service'), 'utf8');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('Environment=AIRBRIDGE_SUPERVISED=systemd');
    expect(unit).toContain('--port 3105');
    expect(fs.readFileSync(path.join(root, 'systemctl'), 'utf8')).toContain('--user enable --now airbridge.service');
    // systemd started it: the installer must not start a second copy.
    expect(fs.existsSync(path.join(root, 'starts'))).toBe(false);
  });
});

describe('install.sh Linux app launcher', () => {
  const linux = () => mock('uname', 'if [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi');
  const launcher = () => path.join(home, '.local/share/applications/airbridge.desktop');
  /** Release binaries embed their help text; mark the mock as one that knows --open. */
  const supportsOpen = () => {
    const curlPath = path.join(mocks, 'curl');
    fs.writeFileSync(curlPath, fs.readFileSync(curlPath, 'utf8').replace("#!/bin/bash\nif [", "#!/bin/bash\n# --open [panel]\nif ["));
  };

  it('writes a launcher with the version and Contacts / Calls / Screen Sharing actions, without running the binary', () => {
    linux();
    supportsOpen();
    const result = install('--no-start');
    expect(result.status, result.stderr).toBe(0);
    const entry = fs.readFileSync(launcher(), 'utf8');
    const bin = path.join(env.AIRBRIDGE_INSTALL_DIR!, 'AirBridge');
    expect(entry).toContain('X-AirBridge-Version=1.0');
    expect(entry).toContain('Comment=AirBridge 1.0');
    expect(entry).toContain(`Exec="${bin}" --open\n`);
    expect(entry).toContain('Actions=Contacts;Calls;ScreenSharing;');
    expect(entry).toContain(`Exec="${bin}" --open calls`);
    expect(entry).toContain('[Desktop Action ScreenSharing]');
    // Probing for --open must not start (or otherwise run) the service.
    expect(fs.existsSync(path.join(root, 'starts'))).toBe(false);
    expect(result.stdout).toContain('app launcher:');
  });

  it('skips binaries that do not know --open, and honours AIRBRIDGE_LAUNCHER=0', () => {
    linux();
    expect(install('--no-start').status).toBe(0);
    expect(fs.existsSync(launcher())).toBe(false);
    supportsOpen();
    env.AIRBRIDGE_LAUNCHER = '0';
    expect(install('--no-start').status).toBe(0);
    expect(fs.existsSync(launcher())).toBe(false);
  });
});

describe('install.sh platform checks', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');

  it('compares the lowercase platform name, so the static musl fallback is reachable on Linux', () => {
    expect(script).toMatch(/platform="linux"/);
    expect(script).toMatch(/if \[ "\$platform" = "linux" \]; then\n\s+if \[ -n "\$\{AIRBRIDGE_VERSION:-\}" \]; then\n\s+musl_url=/);
    expect(script).not.toMatch(/"\$platform" = "Linux"/);
  });

  it('locally assembled app bundles declare Bluetooth use (macOS kills apps that touch CoreBluetooth without it)', () => {
    expect(script).toContain('<key>NSBluetoothAlwaysUsageDescription</key>');
    for (const f of ['scripts/package-mac-app.sh', 'scripts/test-mac-app.sh']) {
      expect(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).toContain('<key>NSBluetoothAlwaysUsageDescription</key>');
    }
  });
});
