import Foundation
import AppKit

// AirBridge Native macOS Swift Notifier using AppKit NSUserNotificationCenter
// Usage: AirBridgeNotifier <title> <body> [appName]

let args = CommandLine.arguments
guard args.count >= 3 else { exit(1) }

let rawTitle = args[1]
let rawBody = args[2]
let appName = args.count > 3 ? args[3] : "AirBridge"

let notifTitle = appName.isEmpty || appName == "AirBridge" ? rawTitle : "\(appName): \(rawTitle)"

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
