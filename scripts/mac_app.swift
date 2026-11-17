import AppKit
import WebKit
import Foundation

/**
 * AirBridge Native macOS Application (AppKit + WebKit + NSStatusItem)
 *
 *  - Native NSWindow + WKWebView hosting the local AirBridge UI
 *  - Menu bar item; closing the window keeps AirBridge running
 *  - Supervises the local AirBridge service (the single-file binary):
 *      * starts it if nothing answers on the port,
 *      * restarts it if it exits or stops answering (watchdog),
 *      * replaces a server of a *different version* (e.g. still running from
 *        before an update) with the installed one,
 *      * reloads the page whenever the service (re)starts, so the window never
 *        keeps showing an old UI or a stale pairing QR,
 *      * stops the service it started when the app quits,
 *      * logs the service output to ~/.airbridge/server.log.
 *  - The page can ask for a restart ("Restart AirBridge" button) through the
 *    `airbridgeShell` script message handler.
 *  - Zero Apple Developer fee ($0), ad-hoc codesigned
 */

struct ServerHealth {
    let version: String?
    let pid: Int32?
}

final class ServiceSupervisor {
    let port: String
    let binaryPath: String
    private(set) var installedVersion: String?
    private var process: Process?
    private let stateLock = NSLock()
    private var _quitting = false
    private var _ownPid: Int32 = 0
    /// Set from the main thread on quit while the supervisor queue may be busy.
    private var quitting: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _quitting }
        set { stateLock.lock(); _quitting = newValue; stateLock.unlock() }
    }
    private var ownPid: Int32 {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _ownPid }
        set { stateLock.lock(); _ownPid = newValue; stateLock.unlock() }
    }
    private var consecutiveFailures = 0
    private var recentStarts: [Date] = []
    private var lastReplaceAttempt = Date.distantPast
    private var lastSeenPid: Int32?
    private let queue = DispatchQueue(label: "airbridge.supervisor")
    private var timer: DispatchSourceTimer?
    /// Called on the main queue when a (new) service instance is ready.
    var onServiceReady: (() -> Void)?
    /// Called on the main queue when the service is unreachable.
    var onServiceDown: (() -> Void)?

    init(port: String, binaryPath: String) {
        self.port = port
        self.binaryPath = binaryPath
    }

    var healthURL: URL { URL(string: "http://localhost:\(port)/api/health")! }

    func start() {
        queue.async {
            self.installedVersion = self.readInstalledVersion()
            self.tick()
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now() + 3, repeating: 3)
            t.setEventHandler { [weak self] in self?.tick() }
            t.resume()
            self.timer = t
        }
    }

    /// Stop the service this app started (not one started elsewhere).
    func stop() {
        quitting = true
        // Never block quitting behind a start-up wait on the supervisor queue.
        let pid = ownPid
        if pid > 1 { kill(pid, SIGTERM) }
        queue.async { self.timer?.cancel() }
    }

    /// User asked for a restart from the page.
    func restart() {
        queue.async {
            if let p = self.process, p.isRunning {
                p.terminate()
                p.waitUntilExit()
            } else if let health = self.fetchHealth(), let pid = health.pid ?? self.listenerPid() {
                self.terminateAirBridge(pid: pid)
            }
            self.process = nil
            self.consecutiveFailures = 0
            self.spawnAndWait()
        }
    }

    // MARK: - Watchdog

    private func tick() {
        if quitting { return }
        if let health = fetchHealth() {
            consecutiveFailures = 0
            if needsReplacement(health), Date().timeIntervalSince(lastReplaceAttempt) > 60 {
                lastReplaceAttempt = Date()
                log("replacing AirBridge \(health.version ?? "unknown") with installed \(installedVersion ?? "?")")
                if let pid = health.pid ?? listenerPid() {
                    terminateAirBridge(pid: pid)
                }
                process = nil
                spawnAndWait()
                return
            }
            // A different instance than last time (restarted elsewhere): reload the UI.
            if let pid = health.pid, pid != lastSeenPid {
                lastSeenPid = pid
                notifyReady()
            } else if lastSeenPid == nil {
                lastSeenPid = health.pid ?? -1
                notifyReady()
            }
            return
        }
        consecutiveFailures += 1
        DispatchQueue.main.async { self.onServiceDown?() }
        let ownRunning = process?.isRunning ?? false
        // Not running at all → start now. Running but not answering for ~9 s → restart.
        if !ownRunning || consecutiveFailures >= 3 {
            if let p = process, p.isRunning {
                log("service not responding; restarting")
                p.terminate()
                p.waitUntilExit()
            }
            process = nil
            spawnAndWait()
        }
    }

    private func needsReplacement(_ health: ServerHealth) -> Bool {
        // Our own child holds the port: it *is* the installed binary (even if
        // that build is too old to report a version).
        if let p = process, p.isRunning { return false }
        if let pid = health.pid, pid == ownPid { return false }
        guard let installed = installedVersion else { return false }
        guard let running = health.version else { return true } // pre-version server = older build
        if running == "dev" { return false }
        return running != installed
    }

    private func notifyReady() {
        DispatchQueue.main.async { self.onServiceReady?() }
    }

    // MARK: - Process management

    private func spawnAndWait() {
        guard !quitting else { return }
        guard FileManager.default.isExecutableFile(atPath: binaryPath) else {
            log("AirBridge binary not found at \(binaryPath)")
            return
        }
        // Crash-loop guard: at most 5 starts per minute.
        let now = Date()
        recentStarts = recentStarts.filter { now.timeIntervalSince($0) < 60 }
        if recentStarts.count >= 5 {
            log("service keeps exiting; waiting before the next start (see server.log)")
            return
        }
        recentStarts.append(now)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binaryPath)
        proc.arguments = ["--no-browser", "--port", port]
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = port
        proc.environment = env
        if let handle = logHandle() {
            proc.standardOutput = handle
            proc.standardError = handle
        }
        proc.terminationHandler = { [weak self] p in
            guard let self = self else { return }
            self.queue.async {
                if self.quitting { return }
                self.log("service exited (status \(p.terminationStatus))")
                // A process we replaced on purpose: its successor owns the state.
                guard self.process === p else { return }
                self.process = nil
                self.ownPid = 0
                self.lastSeenPid = nil
                DispatchQueue.main.async { self.onServiceDown?() }
                self.queue.asyncAfter(deadline: .now() + 1) { self.tick() }
            }
        }
        do {
            try proc.run()
        } catch {
            log("could not start AirBridge: \(error.localizedDescription)")
            return
        }
        process = proc
        ownPid = proc.processIdentifier
        lastSeenPid = nil
        log("started AirBridge pid \(proc.processIdentifier)")
        // TLS certificate generation can take a few seconds on the first launch.
        for _ in 0..<240 { // up to 60 s
            if quitting || !proc.isRunning { return }
            if let health = fetchHealth() {
                lastSeenPid = health.pid ?? proc.processIdentifier
                consecutiveFailures = 0
                notifyReady()
                return
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
    }

    private func readInstalledVersion() -> String? {
        guard FileManager.default.isExecutableFile(atPath: binaryPath) else { return nil }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binaryPath)
        proc.arguments = ["--version"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do { try proc.run() } catch { return nil }
        proc.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // "airbridge 0.0.5"
        return text.split(separator: " ").last.map(String.init)
    }

    /// Only ever terminate a process that is an AirBridge server.
    private func terminateAirBridge(pid: Int32) {
        guard pid > 1, pid != getpid() else { return }
        let command = run("/bin/ps", ["-p", "\(pid)", "-o", "command="])
        guard command.range(of: "airbridge", options: .caseInsensitive) != nil else {
            log("port \(port) is used by another program (pid \(pid)); not touching it")
            return
        }
        kill(pid, SIGTERM)
        for _ in 0..<20 {
            if kill(pid, 0) != 0 { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        kill(pid, SIGKILL)
        Thread.sleep(forTimeInterval: 0.2)
    }

    private func listenerPid() -> Int32? {
        let out = run("/usr/sbin/lsof", ["-nP", "-tiTCP:\(port)", "-sTCP:LISTEN"])
        return out.split(separator: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }.first
    }

    private func run(_ path: String, _ args: [String]) -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do { try proc.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func fetchHealth() -> ServerHealth? {
        var request = URLRequest(url: healthURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 2.0)
        request.httpMethod = "GET"
        let semaphore = DispatchSemaphore(value: 0)
        var result: ServerHealth?
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            guard error == nil, let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (json["service"] as? String) == "AirBridge Warp Server" else { return }
            let pid = (json["pid"] as? NSNumber).map { Int32(truncating: $0) }
            result = ServerHealth(version: json["version"] as? String, pid: pid)
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 3.0)
        return result
    }

    // MARK: - Logging

    private var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".airbridge/server.log")
    }

    private func logHandle() -> FileHandle? {
        let url = logURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let size = attrs[.size] as? NSNumber, size.intValue > 5_000_000 {
            try? FileManager.default.removeItem(at: url)
        }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    func log(_ message: String) {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] [app] \(message)\n"
        if let handle = logHandle(), let data = line.data(using: .utf8) {
            handle.write(data)
            try? handle.close()
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var supervisor: ServiceSupervisor!
    var pageLoaded = false

    private static func resource(_ name: String) -> String? {
        guard let dir = Bundle.main.resourcePath else { return nil }
        let path = (dir as NSString).appendingPathComponent(name)
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // install.sh writes the port and binary path into the bundle.
        let port = ProcessInfo.processInfo.environment["PORT"] ?? AppDelegate.resource("port") ?? "3000"
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let binaryPath = AppDelegate.resource("binary-path") ?? "\(home)/.local/bin/AirBridge"

        // 1. Status Bar Menu Item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.title = "A"
            button.toolTip = "AirBridge — Fast E2EE File Transfer"

            let menu = NSMenu()
            menu.addItem(NSMenuItem(title: "Open AirBridge", action: #selector(showWindow), keyEquivalent: "o"))
            menu.addItem(NSMenuItem(title: "Restart AirBridge Service", action: #selector(restartService), keyEquivalent: "r"))
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Quit AirBridge", action: #selector(terminateApp), keyEquivalent: "q"))
            statusItem.menu = menu
        }

        // 2. Native macOS Window
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

        // 3. WKWebView (+ "Restart AirBridge" bridge for the page)
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController.add(self, name: "airbridgeShell")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView?.addSubview(webView)

        // 4. Supervise the service; (re)load the UI whenever it (re)starts.
        supervisor = ServiceSupervisor(port: port, binaryPath: binaryPath)
        supervisor.onServiceReady = { [weak self] in self?.loadUI() }
        supervisor.start()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func loadUI() {
        guard let url = URL(string: "http://localhost:\(supervisor.port)") else { return }
        // Never show a cached page from an older build.
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if !pageLoaded { loadUI() }
    }

    @objc func restartService() {
        supervisor.restart()
    }

    @objc func terminateApp() {
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        supervisor?.stop()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        return false // Hide to dock & status bar instead of quitting
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    // --- Page → app messages ---
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "airbridgeShell",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        if action == "restart-server" {
            supervisor.restart()
        }
    }

    // --- Navigation state (the watchdog reloads after a failed load) ---
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        pageLoaded = false
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

// SIGTERM/SIGINT (logout, `kill`, Activity Monitor) → normal quit, so the
// service this app started is stopped too instead of being orphaned.
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { NSApp.terminate(nil) }
    source.resume()
    signalSources.append(source)
}
app.setActivationPolicy(.regular)
app.run()
