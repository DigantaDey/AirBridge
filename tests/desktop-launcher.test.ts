import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LAUNCHER_ACTIONS,
  buildLinuxLauncherEntry,
  isShellPanel,
  launcherVersion,
  linuxLauncherPath,
  panelUrl,
  probeRunningInstance,
  quoteExecArg,
  removeLinuxLauncher,
  writeLinuxLauncher,
} from '../src/server/desktopLauncher.ts';

const root = path.resolve(__dirname, '..');
const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launcher-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Minimal Desktop Entry parser: { group: { key: value } }. */
function parseEntry(text: string): Record<string, Record<string, string>> {
  const groups: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const g = /^\[(.+)\]$/.exec(line);
    if (g) { current = groups[g[1]] = {}; continue; }
    const kv = /^([A-Za-z0-9-]+)=(.*)$/.exec(line);
    if (!kv || !current) throw new Error(`bad line: ${line}`);
    current[kv[1]] = kv[2];
  }
  return groups;
}

/** Unquotes an Exec value per the spec (string escapes, then quoting). */
function execArgv(exec: string): string[] {
  const unescaped = exec.replace(/\\\\/g, '\\');
  const args: string[] = [];
  let i = 0;
  while (i < unescaped.length) {
    if (unescaped[i] === ' ') { i++; continue; }
    let arg = '';
    if (unescaped[i] === '"') {
      i++;
      while (unescaped[i] !== '"') {
        if (unescaped[i] === '\\') i++;
        arg += unescaped[i++];
      }
      i++;
    } else {
      while (i < unescaped.length && unescaped[i] !== ' ') arg += unescaped[i++];
    }
    args.push(arg.replace(/%%/g, '%'));
  }
  return args;
}

describe('desktop launcher (Linux top bar / dock / app grid)', () => {
  it('validates panel names and builds panel URLs', () => {
    expect(['contacts', 'calls', 'screen', 'settings'].every(isShellPanel)).toBe(true);
    expect(isShellPanel('home')).toBe(false);
    expect(isShellPanel('javascript:alert(1)')).toBe(false);
    expect(isShellPanel(undefined)).toBe(false);
    expect(panelUrl('http://localhost:3000/', 'calls')).toBe('http://localhost:3000/?panel=calls');
    expect(panelUrl('http://localhost:3000', null)).toBe('http://localhost:3000/');
  });

  it('writes a spec-shaped entry with the version and Contacts / Calls / Screen Sharing actions', () => {
    const text = buildLinuxLauncherEntry({ executable: '/home/u/.local/bin/AirBridge', version: '0.0.6' });
    const entry = parseEntry(text);
    const main = entry['Desktop Entry'];
    expect(main.Type).toBe('Application');
    expect(main.Name).toBe('AirBridge');
    expect(main.Comment).toContain('AirBridge 0.0.6');
    expect(main['X-AirBridge-Version']).toBe('0.0.6');
    expect(launcherVersion(text)).toBe('0.0.6');
    expect(main.Categories.endsWith(';')).toBe(true);
    expect(execArgv(main.Exec)).toEqual(['/home/u/.local/bin/AirBridge', '--open']);
    expect(main.Actions).toBe('Contacts;Calls;ScreenSharing;');
    for (const action of LAUNCHER_ACTIONS) {
      const group = entry[`Desktop Action ${action.id}`];
      expect(group.Name).toBe(action.name);
      expect(execArgv(group.Exec)).toEqual(['/home/u/.local/bin/AirBridge', '--open', action.panel]);
    }
    expect(Object.values(entry['Desktop Action ScreenSharing'])).toContain('Screen Sharing');
  });

  it('quotes awkward executable paths so the desktop parses them back exactly', () => {
    const exe = '/home/a b/$x"y\\z%/Air`Bridge';
    expect(execArgv(quoteExecArg(exe))).toEqual([exe]);
    expect(quoteExecArg('/usr/bin/airbridge')).toBe('/usr/bin/airbridge');
    const text = buildLinuxLauncherEntry({ executable: exe, version: '1.2.3\nInjected=1', extraArgs: ['--port', '4000'] });
    const entry = parseEntry(text);
    expect(execArgv(entry['Desktop Entry'].Exec)).toEqual([exe, '--port', '4000', '--open']);
    expect(execArgv(entry['Desktop Action Calls'].Exec)).toEqual([exe, '--port', '4000', '--open', 'calls']);
    // A newline in the version cannot inject keys.
    expect(entry['Desktop Entry'].Injected).toBeUndefined();
  });

  it('honours XDG_DATA_HOME and ignores a relative one (spec)', () => {
    expect(linuxLauncherPath({ XDG_DATA_HOME: '/data' }, '/home/u')).toBe(path.join('/data', 'applications', 'airbridge.desktop'));
    expect(linuxLauncherPath({ XDG_DATA_HOME: 'rel' }, '/home/u')).toBe(path.join('/home/u', '.local', 'share', 'applications', 'airbridge.desktop'));
    expect(linuxLauncherPath({}, '/home/u')).toBe(path.join('/home/u', '.local', 'share', 'applications', 'airbridge.desktop'));
  });

  it('installs, refreshes the version after an update, and never recreates a removed launcher', () => {
    const file = path.join(tmp(), 'applications', 'airbridge.desktop');
    // Refresh-only on a machine without a launcher: nothing is created.
    expect(writeLinuxLauncher({ executable: '/bin/ab', version: '0.0.5', file })).toBeNull();
    expect(fs.existsSync(file)).toBe(false);

    expect(writeLinuxLauncher({ executable: '/bin/ab', version: '0.0.5', file, install: true })).toBe(file);
    expect(launcherVersion(fs.readFileSync(file, 'utf8'))).toBe('0.0.5');
    // Unchanged → no rewrite.
    expect(writeLinuxLauncher({ executable: '/bin/ab', version: '0.0.5', file })).toBeNull();
    // Self-update to 0.0.6 → the top bar / dock shows the new version.
    expect(writeLinuxLauncher({ executable: '/bin/ab', version: '0.0.6', file })).toBe(file);
    expect(launcherVersion(fs.readFileSync(file, 'utf8'))).toBe('0.0.6');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['airbridge.desktop']); // no temp files left

    removeLinuxLauncher(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(writeLinuxLauncher({ executable: '/bin/ab', version: '0.0.7', file })).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('detects a running AirBridge so launcher actions hand off instead of starting a second server', async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await probeRunningInstance(3000, reply(200, { status: 'ok', service: 'AirBridge Warp Server', version: '0.0.6' })))
      .toEqual({ version: '0.0.6', url: 'http://localhost:3000' });
    // Another app on the port is not AirBridge.
    expect(await probeRunningInstance(3000, reply(200, { service: 'nginx' }))).toBeNull();
    expect(await probeRunningInstance(3000, reply(500, {}))).toBeNull();
    const refused = (async () => { throw new TypeError('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await probeRunningInstance(3000, refused)).toBeNull();
    // A hung listener times out quickly.
    const hang = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await probeRunningInstance(3000, hang, 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('desktop shell integration stays wired', () => {
  it('desktop-entry supports --open and installs/refreshes the launcher', () => {
    const src = fs.readFileSync(path.join(root, 'packaging/desktop-entry.ts'), 'utf8');
    expect(src).toContain("arg === '--open'");
    expect(src).toContain('probeRunningInstance(opts.port)');
    expect(src).toMatch(/writeLinuxLauncher\(\{ executable: exe, version: VERSION/);
    expect(src).toMatch(/writeLinuxLauncher\(\{ executable: currentExecutable\(\), version: VERSION/);
    expect(src).toContain('removeLinuxLauncher()');
  });

  it('install.sh writes the same launcher (actions, version, escaping)', () => {
    const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
    expect(sh).toContain('Actions=Contacts;Calls;ScreenSharing;');
    expect(sh).toContain('X-AirBridge-Version=$app_version');
    // Only binaries that know --open (it's in their --help) get a launcher.
    expect(sh).toContain(`[ "$mode" = "binary" ]`);
    expect(sh).toContain(`grep -aqF -- '--open [panel]' "$bin"`);
    expect(fs.readFileSync(path.join(root, 'packaging/desktop-entry.ts'), 'utf8')).toMatch(/^ {4}--open \[panel\]/m);
    for (const action of LAUNCHER_ACTIONS) {
      expect(sh).toContain(`[Desktop Action ${action.id}]`);
      expect(sh).toContain(`Name=${action.name}`);
      expect(sh).toContain(`Exec=$exec_bin --open ${action.panel}`);
    }
    // Run the installer's escaping pipeline on an awkward path: it must agree with the TS one.
    const line = /exec_bin="(.+)"$/m.exec(sh)![1];
    const exe = '/home/a b/$x"y\\z%/AirBridge';
    const res = spawnSync('bash', ['-c', `bin="$1"; printf '%s' "${line}"`, 'x', exe], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(quoteExecArg(exe));
  });

  it('the macOS menu bar shows the version and Contacts / Calls / Screen Sharing', () => {
    const swift = fs.readFileSync(path.join(root, 'scripts/mac_app.swift'), 'utf8');
    expect(swift).toContain('CFBundleShortVersionString');
    expect(swift).toContain('versionMenuItem');
    expect(swift).toMatch(/version\.isEnabled = false/);
    expect(swift).toContain('button?.toolTip');
    for (const [title, selector] of [['Contacts', 'openContacts'], ['Calls', 'openCalls'], ['Screen Sharing', 'openScreenSharing']]) {
      expect(swift).toContain(`NSMenuItem(title: "${title}", action: #selector(${selector})`);
      expect(swift).toContain(`@objc func ${selector}()`);
    }
    // Panel names match what the page accepts.
    expect(swift).toContain('["contacts", "calls", "screen", "settings"].contains(panel)');
    expect(swift).toContain('window.__airbridgeOpenPanel');
    expect(swift).toContain('__airbridgePendingPanel');
    // A standard app menu: About shows the version, Edit makes ⌘C/⌘V work.
    expect(swift).toContain('orderFrontStandardAboutPanel');
    expect(swift).toContain('NSApp.mainMenu = main');
    // The bundle carries the release version for the menu to show.
    const pkg = fs.readFileSync(path.join(root, 'scripts/package-mac-app.sh'), 'utf8');
    expect(pkg).toMatch(/CFBundleShortVersionString<\/key><string>\$\{?VERSION\}?</);
  });
});
