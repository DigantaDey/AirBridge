import { execFile } from 'node:child_process';

/**
 * Posts a native macOS desktop notification using built-in osascript.
 * Zero external dependencies, works on all versions of macOS.
 */
export function postMacOsNotification(title: string, body: string, appName?: string): void {
  if (process.platform !== 'darwin') return;
  const cleanTitle = (appName ? `${appName}: ${title}` : title).trim();
  const cleanBody = body.trim();
  if (!cleanTitle && !cleanBody) return;

  const script = `display notification ${JSON.stringify(cleanBody)} with title ${JSON.stringify(cleanTitle)} sound name "default"`;

  execFile('osascript', ['-e', script], (err) => {
    if (err) {
      console.warn('[AirBridgeNotif] osascript notification failed:', err.message);
    }
  });
}
