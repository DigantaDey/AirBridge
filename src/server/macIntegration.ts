import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { LocalDaemonStatus } from '../shared/protocol.js';

export interface MacDaemonConfig {
  enabled: boolean;
  downloadDir: string;
  autoSaveToDownloads: boolean;
  notifyOnReceive: boolean;
  revealInFinder: boolean;
}

export function createMacDaemonConfig(overrides?: Partial<MacDaemonConfig>): MacDaemonConfig {
  // Default to enabled outside test mode so Mac clients auto-save to the
  // received-files folder without requiring AIRBRIDGE_LOCAL_DAEMON=1.
  // Tests explicitly pass daemonConfig or set AIRBRIDGE_LOCAL_DAEMON=0 to opt out.
  const envFlag = process.env.AIRBRIDGE_LOCAL_DAEMON;
  let defaultEnabled: boolean;
  if (envFlag === '0') defaultEnabled = false;
  else if (envFlag === '1') defaultEnabled = true;
  else if (process.env.NODE_ENV === 'test') defaultEnabled = false;
  else defaultEnabled = true;
  const defaultDir =
    process.env.AIRBRIDGE_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'AirBridge');

  return {
    enabled: overrides?.enabled ?? defaultEnabled,
    downloadDir: overrides?.downloadDir ?? defaultDir,
    autoSaveToDownloads: overrides?.autoSaveToDownloads ?? defaultEnabled,
    notifyOnReceive: overrides?.notifyOnReceive ?? process.platform === 'darwin',
    revealInFinder: overrides?.revealInFinder ?? false,
  };
}

/**
 * Validate a user-chosen received-files directory. The path must be absolute
 * (a relative path would silently depend on the server's working directory),
 * free of NUL/control characters, and reasonably short. It is intentionally
 * NOT restricted to ~/Downloads: choosing where your own files land is the
 * whole point of the setting. Callers must still gate *who* may change it
 * (loopback-only HTTP route / host desktop client).
 */
export function validateDownloadDir(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Download folder must be a path string.');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 1024 || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('Download folder path is empty or invalid.');
  }
  const expanded = trimmed === '~' ? os.homedir() : trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  if (!path.isAbsolute(expanded)) throw new Error('Download folder must be an absolute path (or start with ~/).');
  return path.resolve(expanded);
}

export async function setDownloadDir(config: MacDaemonConfig, raw: unknown): Promise<string> {
  const dir = validateDownloadDir(raw);
  await fs.promises.mkdir(dir, { recursive: true });
  const stat = await fs.promises.stat(dir);
  if (!stat.isDirectory()) throw new Error('Download folder path is not a directory.');
  config.downloadDir = dir;
  return dir;
}

/** Persist only the received-files folder choice (no secrets involved). */
export async function loadPersistedDownloadDir(filePath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as { downloadDir?: unknown };
    return validateDownloadDir(parsed.downloadDir);
  } catch { return null; }
}

export async function persistDownloadDir(filePath: string, dir: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify({ downloadDir: dir }, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
}

/** Open a folder (or reveal a file) with the OS file manager — fixed argv, never a shell. */
export async function openFolderInFileManager(targetPath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const stat = await fs.promises.stat(targetPath).catch(() => null);
  if (!stat) throw new Error('Folder does not exist yet. Receive a file first or save the setting again.');
  const isDir = stat.isDirectory();
  const [cmd, args]: [string, string[]] = platform === 'darwin'
    ? (isDir ? ['open', [targetPath]] : ['open', ['-R', targetPath]])
    : platform === 'win32' ? ['explorer.exe', [targetPath]] : ['xdg-open', [isDir ? targetPath : path.dirname(targetPath)]];
  await new Promise<void>((resolve, reject) => {
    execFile(cmd, args, (err) => (err && platform !== 'win32' ? reject(new Error('Could not open the folder in the file manager.')) : resolve()));
  });
}

export function getDaemonStatus(config: MacDaemonConfig): LocalDaemonStatus {
  return {
    enabled: config.enabled,
    platform: process.platform,
    hostname: os.hostname(),
    downloadDir: config.enabled ? config.downloadDir : undefined,
    autoSaveToDownloads: config.enabled && config.autoSaveToDownloads,
  };
}

export function sanitizeFilename(rawName: string): string {
  const base = path.basename(rawName.replace(/\\/g, '/')).trim();
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return `airbridge-file-${Date.now()}`;
  }
  return cleaned;
}

export async function saveBufferToLocalDownloads(
  config: MacDaemonConfig,
  filename: string,
  data: Buffer,
  senderName?: string
): Promise<{ savedPath: string; finalName: string }> {
  if (!config.enabled) {
    throw new Error('Local daemon mode is not enabled on this server.');
  }

  await fs.promises.mkdir(config.downloadDir, { recursive: true });

  const safeName = sanitizeFilename(filename);
  const ext = path.extname(safeName);
  const stem = path.basename(safeName, ext);

  let candidate = safeName;
  let counter = 1;
  while (fs.existsSync(path.join(config.downloadDir, candidate))) {
    candidate = `${stem} (${counter})${ext}`;
    counter++;
  }

  const finalPath = path.join(config.downloadDir, candidate);
  const tempPath = `${finalPath}.airbridge.part`;

  await fs.promises.writeFile(tempPath, data);
  await fs.promises.rename(tempPath, finalPath);

  if (process.platform === 'darwin') {
    if (config.notifyOnReceive) {
      triggerMacNotification(
        'AirBridge — File Received',
        `${candidate}${senderName ? ` from ${senderName}` : ''} saved to Downloads`
      );
    }
    if (config.revealInFinder) {
      execFile('open', ['-R', finalPath], () => {});
    }
  }

  return { savedPath: finalPath, finalName: candidate };
}

export function triggerMacNotification(title: string, subtitle: string): void {
  if (process.platform !== 'darwin') return;
  const safeTitle = title.replace(/["\\]/g, '');
  const safeSub = subtitle.replace(/["\\]/g, '');
  const script = `display notification "${safeSub}" with title "${safeTitle}" sound name "Glass"`;
  execFile('osascript', ['-e', script], () => {});
}
