import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOTIFIER_DIR = path.join(os.homedir(), '.airbridge', 'bin');
const NOTIFIER_PATH = path.join(NOTIFIER_DIR, 'AirBridgeNotifier');
let notifierTested = false;

function ensureSwiftNotifier(): string | null {
  if (notifierTested) {
    return fs.existsSync(NOTIFIER_PATH) ? NOTIFIER_PATH : null;
  }
  notifierTested = true;
  try {
    if (fs.existsSync(NOTIFIER_PATH)) return NOTIFIER_PATH;
    fs.mkdirSync(NOTIFIER_DIR, { recursive: true });

    // Look for embedded swift script or source script
    const scriptPath = path.join(process.cwd(), 'scripts', 'mac_notifier.swift');
    if (!fs.existsSync(scriptPath)) return null;

    execFileSync('swiftc', ['-O', '-suppress-warnings', scriptPath, '-o', NOTIFIER_PATH], {
      timeout: 15_000,
    });

    if (fs.existsSync(NOTIFIER_PATH)) {
      fs.chmodSync(NOTIFIER_PATH, 0o755);
      return NOTIFIER_PATH;
    }
  } catch (_e) {
    // swiftc unavailable or compilation failed; fallback to osascript
  }
  return null;
}

/**
 * Posts a native macOS desktop notification with the AirBridge icon and alert sound.
 * Never opens browser tabs or launches the app.
 */
export function postMacOsNotification(title: string, body: string, appName?: string): void {
  if (process.platform !== 'darwin') return;
  const cleanTitle = (appName ? `${appName}: ${title}` : title).trim();
  const cleanBody = body.trim();
  if (!cleanTitle && !cleanBody) return;

  const notifier = ensureSwiftNotifier();
  if (notifier) {
    execFile(notifier, [title, body, appName || 'AirBridge'], (err) => {
      if (err) {
        fallbackOsascript(cleanTitle, cleanBody);
      }
    });
    return;
  }

  fallbackOsascript(cleanTitle, cleanBody);
}

function fallbackOsascript(title: string, body: string): void {
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "default"`;
  execFile('osascript', ['-e', script], () => {});
}
