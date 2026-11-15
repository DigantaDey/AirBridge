import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOTIFIER_DIR = path.join(os.homedir(), '.airbridge', 'bin');
const NOTIFIER_PATH = path.join(NOTIFIER_DIR, 'AirBridgeNotifier');
let notifierTested = false;

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

function ensureSwiftNotifier(): string | null {
  if (notifierTested) {
    return fs.existsSync(NOTIFIER_PATH) ? NOTIFIER_PATH : null;
  }
  notifierTested = true;
  try {
    if (fs.existsSync(NOTIFIER_PATH)) return NOTIFIER_PATH;
    fs.mkdirSync(NOTIFIER_DIR, { recursive: true });

    const tempSwift = path.join(NOTIFIER_DIR, `temp_notifier_${process.pid}.swift`);
    fs.writeFileSync(tempSwift, SWIFT_NOTIFIER_CODE, 'utf8');

    execFileSync('swiftc', ['-O', '-suppress-warnings', tempSwift, '-o', NOTIFIER_PATH], {
      timeout: 15_000,
    });

    try { fs.unlinkSync(tempSwift); } catch (_e) {}

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
 * Posts a native macOS desktop notification with the AirBridge title and alert sound.
 * Never opens browser tabs or launches external windows.
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
