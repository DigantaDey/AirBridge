import { execFile } from 'node:child_process';
import { emitShellEvent } from './shellEvents.js';

/**
 * Posts a native macOS notification.
 *
 * Preferred path: the AirBridge macOS app is subscribed to the service's
 * loopback event channel and posts it with UNUserNotificationCenter (proper
 * app identity, icon, Notification Center settings). Fallback when the app is
 * not running: `osascript display notification`, which needs nothing extra.
 *
 * Nothing is compiled or installed at runtime, and nothing here blocks the
 * event loop (a synchronous helper compile once froze the service long enough
 * for its supervisor to restart it in a loop).
 */
export function postMacOsNotification(
  title: string,
  body: string,
  appName?: string,
  platform: NodeJS.Platform = process.platform,
  fallback: (title: string, body: string) => void = fallbackOsascript,
): 'shell' | 'osascript' | 'skipped' {
  if (platform !== 'darwin') return 'skipped';
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (!cleanTitle && !cleanBody) return 'skipped';

  if (emitShellEvent({ type: 'notification', title: cleanTitle, body: cleanBody, appName: appName?.trim() || undefined })) {
    return 'shell';
  }
  const shown = appName && appName !== 'AirBridge' ? `${appName}: ${cleanTitle}` : cleanTitle;
  fallback(shown, cleanBody);
  return 'osascript';
}

function fallbackOsascript(title: string, body: string): void {
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "default"`;
  execFile('osascript', ['-e', script], () => {});
}
