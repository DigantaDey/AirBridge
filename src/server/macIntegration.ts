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
  const enabledByEnv = process.env.AIRBRIDGE_LOCAL_DAEMON === '1';
  const defaultDir =
    process.env.AIRBRIDGE_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'AirBridge');

  return {
    enabled: overrides?.enabled ?? enabledByEnv,
    downloadDir: overrides?.downloadDir ?? defaultDir,
    autoSaveToDownloads: overrides?.autoSaveToDownloads ?? enabledByEnv,
    notifyOnReceive: overrides?.notifyOnReceive ?? process.platform === 'darwin',
    revealInFinder: overrides?.revealInFinder ?? false,
  };
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
