import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOTIFIER_DIR = process.env.AIRBRIDGE_NOTIFIER_DIR || path.join(os.homedir(), '.airbridge', 'bin');
const NOTIFIER_PATH = path.join(NOTIFIER_DIR, 'AirBridgeNotifier');

const SWIFT_NOTIFIER_CODE = `import Foundation
import AppKit

// AirBridge Native macOS Swift Notifier
// Usage: AirBridgeNotifier <title> <body> [appName]

let args = CommandLine.arguments
guard args.count >= 3 else { exit(1) }

let rawTitle = args[1]
let rawBody = args[2]
let appName = args.count > 3 ? args[3] : "AirBridge"

let notifTitle = appName.isEmpty || appName == "AirBridge" ? rawTitle : "\\(appName): \\(rawTitle)"

@objc class NotifDelegate: NSObject, NSUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: NSUserNotificationCenter, shouldPresent notification: NSUserNotification) -> Bool {
        return true
    }
}

let delegate = NotifDelegate()
let center = NSUserNotificationCenter.default
center.delegate = delegate

let notification = NSUserNotification()
notification.title = notifTitle
notification.informativeText = rawBody
notification.soundName = NSUserNotificationDefaultSoundName

center.deliver(notification)
RunLoop.main.run(until: Date().addingTimeInterval(0.3))
exit(0)
`;

type NotifierState = 'unknown' | 'building' | 'ready' | 'unavailable';
let notifierState: NotifierState = 'unknown';

/** Test hook: forget the cached notifier state. */
export function resetMacNotifierForTests(): void {
  notifierState = 'unknown';
}

/**
 * Returns the compiled notifier if it is ready; otherwise starts building it
 * in the background and returns null (the caller falls back to osascript).
 *
 * Never blocks: compiling with swiftc takes 5–30 s on a cold module cache, and
 * the server must keep answering /api/health and WebSockets meanwhile — a
 * blocking compile here made the macOS app's watchdog restart the service in
 * a loop (each restart killed the compile, so it never finished).
 */
function ensureSwiftNotifier(): string | null {
  if (notifierState === 'ready') return NOTIFIER_PATH;
  if (notifierState === 'building' || notifierState === 'unavailable') return null;
  try {
    if (fs.existsSync(NOTIFIER_PATH)) {
      notifierState = 'ready';
      return NOTIFIER_PATH;
    }
    fs.mkdirSync(NOTIFIER_DIR, { recursive: true });
  } catch {
    notifierState = 'unavailable';
    return null;
  }
  notifierState = 'building';
  const tempSwift = path.join(NOTIFIER_DIR, `temp_notifier_${process.pid}.swift`);
  // Build to a temporary path and rename: a compile interrupted by a restart
  // never leaves a half-written notifier behind.
  const tempBinary = path.join(NOTIFIER_DIR, `.AirBridgeNotifier.${process.pid}.tmp`);
  const cleanup = () => {
    for (const f of [tempSwift, tempBinary]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  };
  try {
    fs.writeFileSync(tempSwift, SWIFT_NOTIFIER_CODE, 'utf8');
  } catch {
    notifierState = 'unavailable';
    return null;
  }
  try {
    const child = execFile(
      'swiftc',
      ['-O', '-suppress-warnings', tempSwift, '-o', tempBinary],
      { timeout: 120_000 },
      (err) => {
        try {
          if (!err && fs.existsSync(tempBinary)) {
            fs.chmodSync(tempBinary, 0o755);
            fs.renameSync(tempBinary, NOTIFIER_PATH);
            notifierState = 'ready';
          } else {
            notifierState = 'unavailable';
          }
        } catch {
          notifierState = 'unavailable';
        }
        cleanup();
      },
    );
    child.on('error', () => {
      notifierState = 'unavailable';
      cleanup();
    });
    child.unref?.();
  } catch {
    notifierState = 'unavailable';
    cleanup();
  }
  return null;
}

/**
 * Posts a native macOS desktop notification with the AirBridge title and alert sound.
 * Never opens browser tabs or launches external windows.
 */
export function postMacOsNotification(title: string, body: string, appName?: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') return;
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
