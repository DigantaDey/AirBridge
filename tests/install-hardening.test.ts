import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = path.resolve('install.sh');
const psInstaller = path.resolve('install.ps1');

let root: string;
let home: string;
let mocks: string;
let installDir: string;
let env: NodeJS.ProcessEnv;

function mock(name: string, script: string) {
  fs.writeFileSync(path.join(mocks, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
}

function runInstall(...args: string[]) {
  return spawnSync('bash', [installer, ...args], { env, encoding: 'utf8', timeout: 15_000 });
}

function writeBinaryAndSums(binContent: string, sumsContent: string) {
  fs.writeFileSync(path.join(root, 'mock-bin'), binContent);
  fs.writeFileSync(path.join(root, 'mock-sums'), sumsContent);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-install-sec-')));
  home = path.join(root, 'home');
  mocks = path.join(root, 'mocks');
  installDir = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(mocks, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  env = {
    ...process.env,
    HOME: home,
    PATH: `${mocks}:${process.env.PATH}`,
    AIRBRIDGE_INSTALL_DIR: installDir,
    AIRBRIDGE_NATIVE_APP: '0',
    AIRBRIDGE_PREBUILT_APP: '0',
    AIRBRIDGE_ALLOW_SOURCE: '1',
    PORT: '3106',
    TEST_ROOT: root,
  };
  mock('uname', 'if [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi');
  mock('codesign', 'exit 0');
  mock('launchctl', 'exit 0');
  mock('pgrep', 'exit 1');
  mock('lsof', 'exit 0');
  mock('open', 'exit 0');
  mock('osascript', 'exit 0');
  mock('sleep', ':');
  mock('curl', `
url="\${!#}"
out=""
for ((i=1;i<=$#;i++)); do if [ "\${!i}" = -o ]; then j=$((i+1)); out="\${!j}"; fi; done
case "$url" in
  *SHA256SUMS*)
    if [ -f "$TEST_ROOT/sums-fail" ]; then exit 22; fi
    cp "$TEST_ROOT/mock-sums" "$out"
    ;;
  *AirBridge.icns)
    echo "icon" > "$out"
    ;;
  *)
    cp "$TEST_ROOT/mock-bin" "$out"
    ;;
esac
`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('install.sh supply-chain fail-closed checksums (S-4)', () => {
  const validBin = '#!/bin/bash\nif [ "$1" = --version ]; then echo "airbridge 2.4.8"; exit 0; fi\n';
  const validSha = crypto.createHash('sha256').update(validBin).digest('hex');

  it('fails closed when SHA256SUMS.txt download fails (404) and preserves existing binary', () => {
    const existingBin = path.join(installDir, 'AirBridge');
    fs.writeFileSync(existingBin, 'existing-good-binary', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'sums-fail'), '1');
    writeBinaryAndSums(validBin, '');

    const res = runInstall('--no-start');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('could not download SHA256SUMS.txt');
    expect(fs.readFileSync(existingBin, 'utf8')).toBe('existing-good-binary');
    expect(fs.existsSync(`${existingBin}.tmp`)).toBe(false);
  }, 15_000);

  it('fails closed when SHA256SUMS.txt is empty', () => {
    writeBinaryAndSums(validBin, '');
    const res = runInstall('--no-start');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('could not download SHA256SUMS.txt');
    expect(fs.existsSync(path.join(installDir, 'AirBridge'))).toBe(false);
  }, 15_000);

  it('fails closed when SHA256SUMS.txt is HTML or has an invalid hash format', () => {
    writeBinaryAndSums(validBin, '<html><body>Not Found</body></html>\nnot-a-hex-digest  AirBridge-linux-x64\n');
    const res = runInstall('--no-start');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('no valid SHA-256 entry');
    expect(fs.existsSync(path.join(installDir, 'AirBridge'))).toBe(false);
  }, 15_000);

  it('fails closed when SHA256SUMS.txt omits the matching asset entry', () => {
    writeBinaryAndSums(validBin, `${validSha}  AirBridge-linux-arm64\n`);
    const res = runInstall('--no-start');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('no valid SHA-256 entry for AirBridge-linux-x64');
    expect(fs.existsSync(path.join(installDir, 'AirBridge'))).toBe(false);
  }, 15_000);

  it('fails closed on checksum mismatch and does not fall back to source build even with AIRBRIDGE_ALLOW_SOURCE=1', () => {
    mock('git', 'echo "SOURCE_FALLBACK_CALLED" >&2; exit 99');
    writeBinaryAndSums(validBin, `${'a'.repeat(64)}  AirBridge-linux-x64\n`);
    const res = runInstall('--no-start');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('checksum mismatch for AirBridge-linux-x64');
    expect(res.stderr).not.toContain('SOURCE_FALLBACK_CALLED');
    expect(fs.existsSync(path.join(installDir, 'AirBridge'))).toBe(false);
  }, 15_000);

  it('accepts valid SHA256SUMS.txt with * prefix, uppercase hex, and CRLF line endings', () => {
    writeBinaryAndSums(validBin, `${validSha.toUpperCase()} *AirBridge-linux-x64\r\n`);
    const res = runInstall('--no-start');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('checksum verified');
    expect(fs.existsSync(path.join(installDir, 'AirBridge'))).toBe(true);
  }, 15_000);
});

describe('install.sh macOS Sequoia Info.plist & shell safety (P-2)', () => {
  it('writes CFBundleShortVersionString, NSLocalNetworkUsageDescription, and NSBonjourServices for binary installs', () => {
    mock('uname', 'if [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi');
    const bin = '#!/bin/bash\nif [ "$1" = --version ]; then echo "airbridge 2.4.8"; exit 0; fi\n';
    const sha = crypto.createHash('sha256').update(bin).digest('hex');
    writeBinaryAndSums(bin, `${sha}  AirBridge-darwin-arm64\n`);

    const res = runInstall('--no-start');
    expect(res.status, res.stderr).toBe(0);

    const plistPath = path.join(home, 'Applications/AirBridge.app/Contents/Info.plist');
    const plist = fs.readFileSync(plistPath, 'utf8');
    expect(plist).toContain('<key>CFBundleShortVersionString</key><string>2.4.8</string>');
    expect(plist).toContain('<key>CFBundleVersion</key><string>2.4.8</string>');
    expect(plist).toContain('<key>NSLocalNetworkUsageDescription</key>');
    expect(plist).toContain('<key>NSBluetoothAlwaysUsageDescription</key>');
    expect(plist).toContain('<key>NSBonjourServices</key><array><string>_airbridge._tcp</string><string>_airbridge-rv._tcp</string></array>');

    if (process.platform === 'darwin') {
      const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
      expect(lint.status, lint.stderr).toBe(0);
    }
  }, 15_000);

  it('derives version from source package.json in --from-source mode without executing the Node server', () => {
    mock('uname', 'if [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi');
    mock('git', 'mkdir -p "$HOME/.local/share/airbridge/src/.git"');
    mock(
      'npm',
      [
        'mkdir -p "$HOME/.local/share/airbridge/src/dist/server/server"',
        'printf \'{"version":"2.4.8"}\\n\' > "$HOME/.local/share/airbridge/src/package.json"',
        'touch "$HOME/.local/share/airbridge/src/dist/server/server/index.js"',
      ].join('\n'),
    );
    mock(
      'node',
      [
        'if [ "$1" = -p ]; then',
        '  if [ "$2" = "process.versions.node.split(\\".\\")[0]" ]; then echo 22; exit 0; fi',
        '  echo "2.4.8"; exit 0',
        'fi',
        'echo "SERVER_INVOKED_UNEXPECTEDLY" >&2',
        'exit 99',
      ].join('\n'),
    );

    const res = runInstall('--from-source', '--no-start');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).not.toContain('SERVER_INVOKED_UNEXPECTEDLY');

    const plist = fs.readFileSync(path.join(home, 'Applications/AirBridge.app/Contents/Info.plist'), 'utf8');
    expect(plist).toContain('<key>CFBundleShortVersionString</key><string>2.4.8</string>');
    expect(plist).toContain('<key>NSLocalNetworkUsageDescription</key>');
    expect(plist).toContain('<key>NSBonjourServices</key>');
  }, 15_000);

  it('does not use non-random BSD mktemp suffix pattern for swift source temp files', () => {
    const script = fs.readFileSync(installer, 'utf8');
    expect(script).not.toContain('mac_app.XXXXXX.swift');
    expect(script).toContain('mktemp -d');
  });
});

describe('install.ps1 fail-closed checksum enforcement (S-4)', () => {
  const ps1 = fs.readFileSync(psInstaller, 'utf8');

  it('checks curl.exe exit code, requires exact 64-hex asset entry, cleans .tmp, and never swallows checksum errors', () => {
    expect(ps1).toContain('$LASTEXITCODE -ne 0');
    expect(ps1).toContain('^([0-9a-fA-F]{64})\\s+\\*?(\\S+)$');
    expect(ps1).toContain('$matches[2] -ceq $Asset');
    expect(ps1).toContain('SHA256SUMS.txt has no valid SHA-256 entry for $Asset');
    expect(ps1).toContain('Remove-Item "$Exe.tmp" -ErrorAction SilentlyContinue');
    expect(ps1).not.toMatch(/if\s*\("\$\(\$_\.Exception\.Message\)"\s*-like\s*"checksum mismatch\*"\)\s*\{\s*throw\s*\}/);
    expect(ps1).toContain('finally');
  });

  it('executes fail-closed behavior under pwsh when pwsh is available', () => {
    const pwshCheck = spawnSync('which', ['pwsh'], { encoding: 'utf8' });
    if (pwshCheck.status !== 0) {
      return;
    }

    const psRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-ps-test-')));
    try {
      const binDir = path.join(psRoot, 'bin');
      const targetDir = path.join(psRoot, 'install');
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(binDir, 'curl.exe'),
        [
          '#!/bin/bash',
          'out=""',
          'url="${!#}"',
          'for ((i=1;i<=$#;i++)); do if [ "${!i}" = -o ]; then j=$((i+1)); out="${!j}"; fi; done',
          'if [[ "$url" == *SHA256SUMS* ]]; then',
          '  if [ -f "$TEST_PS_ROOT/sums-fail" ]; then exit 22; fi',
          '  cp "$TEST_PS_ROOT/sums" "$out"',
          'else',
          '  printf "fake-exe-bytes" > "$out"',
          'fi',
        ].join('\n'),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(psRoot, 'sums-fail'), '1');
      const res = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', psInstaller], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          AIRBRIDGE_INSTALL_DIR: targetDir,
          TEST_PS_ROOT: psRoot,
          POWERSHELL_TELEMETRY_OPTOUT: '1',
          POWERSHELL_UPDATECHECK: 'Off',
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        },
        encoding: 'utf8',
        timeout: 25_000,
      });
      expect(res.error).toBeUndefined();
      expect(res.status).not.toBe(0);
      expect(fs.existsSync(path.join(targetDir, 'AirBridge.exe'))).toBe(false);
      expect(fs.existsSync(path.join(targetDir, 'AirBridge.exe.tmp'))).toBe(false);
    } finally {
      fs.rmSync(psRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
