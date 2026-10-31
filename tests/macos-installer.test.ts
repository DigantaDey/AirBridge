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
  env = { ...process.env, HOME: home, PATH: `${mocks}:${process.env.PATH}`, AIRBRIDGE_INSTALL_DIR: path.join(home, 'my bin'), PORT: '3105', TEST_ROOT: root };
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
  });
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
});
