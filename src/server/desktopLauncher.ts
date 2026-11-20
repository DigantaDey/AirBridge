/**
 * Desktop launcher integration for the single-file binary on Linux (and the
 * shared "open a panel" plumbing used by every desktop build).
 *
 * The macOS app has a native menu-bar item. Linux desktops expose the same
 * entry points through the XDG application launcher: GNOME's top bar and dash,
 * KDE's panel and task manager, Cinnamon, XFCE and others show a launcher's
 * Desktop Actions in its context menu. The launcher written here:
 *
 *   - shows the running version (Comment + X-AirBridge-Version, refreshed on
 *     every start so it stays right after a self-update),
 *   - offers Contacts / Calls / Screen Sharing actions that open those panels
 *     of the local UI,
 *   - starts AirBridge if it isn't running, or hands off to the running
 *     service (`--open <panel>` just opens the browser) when it is.
 *
 * Kept free of side effects so it is unit-testable (desktop-entry.ts runs
 * main() on import).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHELL_PANELS = ['contacts', 'calls', 'screen', 'settings'] as const;
export type ShellPanel = (typeof SHELL_PANELS)[number];

export function isShellPanel(value: unknown): value is ShellPanel {
  return typeof value === 'string' && (SHELL_PANELS as readonly string[]).includes(value);
}

/** Local UI URL that opens `panel` (the page reads and strips `?panel=`). */
export function panelUrl(baseUrl: string, panel: ShellPanel | null): string {
  const base = baseUrl.replace(/\/+$/, '');
  return panel ? `${base}/?panel=${panel}` : `${base}/`;
}

interface LauncherAction {
  id: string;
  name: string;
  panel: ShellPanel;
  icon: string;
}

export const LAUNCHER_ACTIONS: readonly LauncherAction[] = [
  { id: 'Contacts', name: 'Contacts', panel: 'contacts', icon: 'x-office-address-book' },
  { id: 'Calls', name: 'Calls', panel: 'calls', icon: 'call-start' },
  { id: 'ScreenSharing', name: 'Screen Sharing', panel: 'screen', icon: 'video-display' },
];

/** Quotes one Exec argument per the Desktop Entry spec ("Exec key"). */
export function quoteExecArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg.replace(/%/g, '%%');
  // Quoting rule: backslash-escape " ` $ and backslash inside double quotes.
  // The string escape rule (a doubled backslash) applies on top of that, so
  // every backslash produced here is doubled once more.
  const quoted = arg.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, '%%');
  return `"${quoted.replace(/\\/g, '\\\\')}"`;
}

/** Strips characters that would break a single-line desktop entry value. */
function entryValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export interface LauncherOptions {
  executable: string;
  version: string;
  /** Extra arguments for every Exec line (e.g. a non-default `--port`). */
  extraArgs?: string[];
}

/** The XDG `.desktop` application launcher (Desktop Entry spec 1.5). */
export function buildLinuxLauncherEntry(options: LauncherOptions): string {
  const version = entryValue(options.version || 'dev');
  const exec = (args: string[]) => [options.executable, ...(options.extraArgs ?? []), ...args].map(quoteExecArg).join(' ');
  const lines = [
    '[Desktop Entry]',
    'Version=1.5',
    'Type=Application',
    'Name=AirBridge',
    'GenericName=Phone & File Bridge',
    `Comment=AirBridge ${version} — end-to-end encrypted files, photo & text clipboard, contacts, call audio and H.264 screen sharing (by Diganta Dey)`,
    `Exec=${exec(['--open'])}`,
    'Icon=airbridge',
    'Terminal=false',
    'Categories=Network;FileTransfer;Utility;',
    'Keywords=phone;android;transfer;clipboard;contacts;calls;screen;share;',
    'StartupNotify=false',
    `Actions=${LAUNCHER_ACTIONS.map((a) => a.id).join(';')};`,
    `X-AirBridge-Version=${version}`,
  ];
  for (const action of LAUNCHER_ACTIONS) {
    lines.push('', `[Desktop Action ${action.id}]`, `Name=${action.name}`, `Icon=${action.icon}`, `Exec=${exec(['--open', action.panel])}`);
  }
  return `${lines.join('\n')}\n`;
}

/** `$XDG_DATA_HOME/applications/airbridge.desktop` (default ~/.local/share). */
export function linuxLauncherPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(dataHome, 'applications', 'airbridge.desktop');
}

/** Version recorded in an existing launcher, if any. */
export function launcherVersion(contents: string): string | null {
  const m = /^X-AirBridge-Version=(.+)$/m.exec(contents);
  return m ? m[1].trim() : null;
}

/**
 * Writes (install = true) or refreshes the launcher. Refreshing only touches
 * a launcher that already exists, so users who removed it are respected.
 * Returns the path when the file was written.
 */
export function writeLinuxLauncher(options: LauncherOptions & { install?: boolean; file?: string }): string | null {
  const file = options.file ?? linuxLauncherPath();
  const exists = fs.existsSync(file);
  if (!exists && !options.install) return null;
  const next = buildLinuxLauncherEntry(options);
  if (exists && fs.readFileSync(file, 'utf8') === next) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o644 });
  fs.renameSync(tmp, file); // atomic: a menu never sees a half-written entry
  return file;
}

export function removeLinuxLauncher(file = linuxLauncherPath()): void {
  fs.rmSync(file, { force: true });
}

export interface RunningInstance {
  version: string;
  url: string;
}

/**
 * Is an AirBridge service already answering on this machine's port? Used by
 * `--open` so the launcher hands off instead of starting a second server.
 */
export async function probeRunningInstance(port: number, fetchImpl: typeof fetch = fetch, timeoutMs = 1500): Promise<RunningInstance | null> {
  const url = `http://localhost:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/api/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { service?: unknown; version?: unknown };
    if (typeof body.service !== 'string' || !body.service.startsWith('AirBridge')) return null;
    return { version: typeof body.version === 'string' ? body.version : 'unknown', url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
