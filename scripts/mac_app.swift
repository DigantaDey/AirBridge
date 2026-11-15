import AppKit
import WebKit
import Foundation

/**
 * AirBridge Native macOS Application (AppKit + WebKit + NSStatusItem)
 *
 * Delivers a 100% native macOS GUI window with:
 *  - Native NSWindow with translucent dark titlebar & traffic lights
 *  - Native Menu Bar item (NSStatusItem) for background access
 *  - Native file picker, drag & drop, and download handlers
 *  - Automatic background server process lifecycle management
 *  - Zero Apple Developer fee ($0), ad-hoc codesigned
 */

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var serverProcess: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let port = ProcessInfo.processInfo.environment["PORT"] ?? "3000"

        // 1. Setup Status Bar Menu Item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.title = "A"
            button.toolTip = "AirBridge — Fast E2EE File Transfer"

            let menu = NSMenu()
            menu.addItem(NSMenuItem(title: "Open AirBridge", action: #selector(showWindow), keyEquivalent: "o"))
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Quit AirBridge", action: #selector(terminateApp), keyEquivalent: "q"))
            statusItem.menu = menu
        }

        // 2. Setup Native macOS Window
        let rect = NSRect(x: 0, y: 0, width: 960, height: 720)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "AirBridge"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("AirBridgeMainWindow")
        window.minSize = NSSize(width: 480, height: 600)

        // 3. Setup WKWebView
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window.contentView?.addSubview(webView)

        // 4. Ensure background server is active & load UI
        ensureServerRunning(port: port) { [weak self] in
            DispatchQueue.main.async {
                let urlString = "http://localhost:\(port)"
                if let url = URL(string: urlString) {
                    self?.webView.load(URLRequest(url: url))
                }
            }
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func terminateApp() {
        serverProcess?.terminate()
        NSApp.terminate(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        return false // Hide to dock & status bar instead of quitting
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    // --- Background Server Health & Spawn ---
    private func ensureServerRunning(port: String, completion: @escaping () -> Void) {
        let healthUrl = URL(string: "http://localhost:\(port)/api/health")!
        let request = URLRequest(url: healthUrl, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 1.0)

        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if error == nil, let httpRes = response as? HTTPURLResponse, httpRes.statusCode == 200 {
                completion()
            } else {
                self?.spawnServerBinary(port: port)
                DispatchQueue.global().async {
                    for _ in 0..<30 {
                        Thread.sleep(forTimeInterval: 0.2)
                        let checkReq = URLRequest(url: healthUrl, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 1.0)
                        let semaphore = DispatchSemaphore(value: 0)
                        var success = false
                        let checkTask = URLSession.shared.dataTask(with: checkReq) { d, r, e in
                            if e == nil, let res = r as? HTTPURLResponse, res.statusCode == 200 {
                                success = true
                            }
                            semaphore.signal()
                        }
                        checkTask.resume()
                        _ = semaphore.wait(timeout: .now() + 1.0)
                        if success { break }
                    }
                    completion()
                }
            }
        }
        task.resume()
    }

    private func spawnServerBinary(port: String) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let binaryPath = "\(home)/.local/bin/AirBridge"
        guard FileManager.default.isExecutableFile(atPath: binaryPath) else { return }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binaryPath)
        proc.arguments = ["--no-browser", "--port", port]
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = port
        proc.environment = env
        try? proc.run()
        serverProcess = proc
    }

    // --- WKUIDelegate Native File Picker & Alerts ---
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let openPanel = NSOpenPanel()
        openPanel.canChooseFiles = true
        openPanel.canChooseDirectories = false
        openPanel.allowsMultipleSelection = parameters.allowsMultipleSelection
        openPanel.begin { response in
            if response == .OK {
                completionHandler(openPanel.urls)
            } else {
                completionHandler(nil)
            }
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "AirBridge"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "AirBridge"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let res = alert.runModal()
        completionHandler(res == .alertFirstButtonReturn)
    }

    // --- WKDownloadDelegate Direct File Downloads ---
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let downloadsDir = home.appendingPathComponent("Downloads/AirBridge")
        try? FileManager.default.createDirectory(at: downloadsDir, withIntermediateDirectories: true)
        let fileUrl = downloadsDir.appendingPathComponent(suggestedFilename)
        completionHandler(fileUrl)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
