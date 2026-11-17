import AppKit
import WebKit
import Foundation
import UserNotifications

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
 *  - Native notifications (UNUserNotificationCenter) for events the service
 *    streams over loopback (/api/local/events); if macOS denies permission
 *    the service falls back to osascript by itself.
 *  - Menu: Check for Updates (verified background download, one-click
 *    install + relaunch), Copy Diagnostics, Show Log, Open at Login (a
 *    launchd agent that restarts the app if it crashes).
 *  - Prebuilt bundle (release CI): the service ships inside the app at
 *    Contents/Resources/airbridge-server. Zero Apple Developer fee ($0):
 *    ad-hoc codesigned, no notarization.
 */

struct ServerHealth {
    let version: String?
    let pid: Int32?
}

final class ServiceSupervisor {
    let port: String
    let binaryPath: String
    /// The app bundle when the service ships inside it (self-updates replace the bundle).
    let appBundlePath: String?
    private var _installedVersion: String?
    /// Written on the supervisor queue, read from the main thread (menu, diagnostics).
    private(set) var installedVersion: String? {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _installedVersion }
        set { stateLock.lock(); _installedVersion = newValue; stateLock.unlock() }
    }
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
    /// First failed health check of the current outage (nil while healthy).
    private var unresponsiveSince: Date?
    /// Crash-loop backoff: consecutive starts that exited early, and when the next start may happen.
    private var earlyExits = 0
    private var nextStartAllowed = Date.distantPast
    private var startedAt = Date.distantPast
    /// A live service that is merely busy (first-run TLS setup, a large transfer,
    /// a slow helper) must not be killed: only a long, continuous silence is a hang.
    static let hangGrace: TimeInterval = 90
    private var lastReplaceAttempt = Date.distantPast
    private var lastSeenPid: Int32?
    private let queue = DispatchQueue(label: "airbridge.supervisor")
    private var timer: DispatchSourceTimer?
    /// Called on the main queue when a (new) service instance is ready.
    var onServiceReady: (() -> Void)?
    /// Called on the main queue when the service is unreachable.
    var onServiceDown: (() -> Void)?

    /// Exit status the service uses for "restart me" (after an update / rollback).
    static let restartExitStatus: Int32 = 75

    init(port: String, binaryPath: String, appBundlePath: String? = nil) {
        self.port = port
        self.binaryPath = binaryPath
        self.appBundlePath = appBundlePath
    }

    /// Stop supervising without stopping the service (the app is being relaunched after an update).
    func detach() {
        quitting = true
        queue.async { self.timer?.cancel() }
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
            self.log("restart requested")
            if let p = self.process, p.isRunning {
                self.stopChild(p)
            } else if let pid = self.fetchHealth()?.pid ?? self.listenerPid() {
                _ = self.terminateAirBridge(pid: pid)
            }
            self.process = nil
            self.ownPid = 0
            self.unresponsiveSince = nil
            self.earlyExits = 0
            self.nextStartAllowed = .distantPast
            self.spawnAndWait()
        }
    }

    /// SIGTERM, then SIGKILL if it does not exit within 5 s (never blocks forever).
    private func stopChild(_ p: Process) {
        guard p.isRunning else { return }
        p.terminate()
        for _ in 0..<50 {
            if !p.isRunning { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        kill(p.processIdentifier, SIGKILL)
        Thread.sleep(forTimeInterval: 0.2)
    }

    // MARK: - Watchdog

    private func tick() {
        if quitting { return }
        if let health = fetchHealth() {
            unresponsiveSince = nil
            if needsReplacement(health), Date().timeIntervalSince(lastReplaceAttempt) > 60 {
                lastReplaceAttempt = Date()
                log("replacing AirBridge \(health.version ?? "unknown") with installed \(installedVersion ?? "?")")
                if let pid = health.pid ?? listenerPid() {
                    _ = terminateAirBridge(pid: pid)
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

        let now = Date()
        if unresponsiveSince == nil { unresponsiveSince = now }
        let silentFor = now.timeIntervalSince(unresponsiveSince!)
        DispatchQueue.main.async { self.onServiceDown?() }

        // Our service is alive but not answering: busy, not dead. Restart only a long hang.
        if let p = process, p.isRunning {
            if silentFor >= ServiceSupervisor.hangGrace {
                log("service pid \(p.processIdentifier) has not answered for \(Int(silentFor)) s; restarting it")
                stopChild(p)
                process = nil
                ownPid = 0
                unresponsiveSince = nil
                spawnAndWait()
            }
            return
        }

        // Someone else holds the port (e.g. a login item). Never start a duplicate
        // that can only fail with "address in use"; replace it only if it is an
        // AirBridge that stays silent for the whole grace period.
        if let pid = listenerPid() {
            if silentFor >= ServiceSupervisor.hangGrace, terminateAirBridge(pid: pid) {
                log("AirBridge pid \(pid) on port \(port) has not answered for \(Int(silentFor)) s; replaced it")
                unresponsiveSince = nil
                spawnAndWait()
            }
            return
        }

        // Nothing is running: start it (subject to crash-loop backoff).
        spawnAndWait()
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
        // Crash-loop guard: exponential backoff after starts that exited early.
        let now = Date()
        if now < nextStartAllowed { return }
        startedAt = now
        // The binary may have been replaced by an update since the last start.
        installedVersion = readInstalledVersion()

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binaryPath)
        proc.arguments = ["--no-browser", "--port", port]
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = port
        // Tells the service its restarts are handled here (exit 75 = restart me).
        env["AIRBRIDGE_SUPERVISED"] = "app"
        if let bundle = appBundlePath { env["AIRBRIDGE_APP_BUNDLE"] = bundle } else { env.removeValue(forKey: "AIRBRIDGE_APP_BUNDLE") }
        proc.environment = env
        if let handle = logHandle() {
            proc.standardOutput = handle
            proc.standardError = handle
        }
        proc.terminationHandler = { [weak self] p in
            guard let self = self else { return }
            self.queue.async {
                if self.quitting { return }
                let ranFor = Date().timeIntervalSince(self.startedAt)
                self.log("service pid \(p.processIdentifier) exited (status \(p.terminationStatus)) after \(Int(ranFor)) s")
                // A process we replaced on purpose: its successor owns the state.
                guard self.process === p else { return }
                if p.terminationStatus == ServiceSupervisor.restartExitStatus {
                    self.log("service asked to be restarted (update installed or rolled back)")
                    self.earlyExits = 0
                    self.nextStartAllowed = .distantPast
                } else if ranFor < 30 {
                    self.earlyExits += 1
                    let delay = min(60.0, pow(2.0, Double(self.earlyExits)))
                    self.nextStartAllowed = Date().addingTimeInterval(delay)
                    self.log("service exited soon after starting (\(self.earlyExits)x in a row); next start in \(Int(delay)) s — see the lines above")
                } else {
                    self.earlyExits = 0
                }
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
        // The hang grace period counts from the start, so a slow first start
        // (TLS certificate generation) is never mistaken for a hang.
        unresponsiveSince = now
        log("started AirBridge \(installedVersion ?? "") pid \(proc.processIdentifier)")
        for _ in 0..<240 { // up to 60 s; the watchdog keeps waiting after that
            if quitting || !proc.isRunning { return }
            if let health = fetchHealth() {
                lastSeenPid = health.pid ?? proc.processIdentifier
                unresponsiveSince = nil
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
    @discardableResult
    private func terminateAirBridge(pid: Int32) -> Bool {
        guard pid > 1, pid != getpid() else { return false }
        let command = run("/bin/ps", ["-p", "\(pid)", "-o", "command="])
        guard command.range(of: "airbridge", options: .caseInsensitive) != nil else {
            log("port \(port) is used by another program (pid \(pid)); not touching it")
            return false
        }
        kill(pid, SIGTERM)
        for _ in 0..<50 {
            if kill(pid, 0) != 0 { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        kill(pid, SIGKILL)
        Thread.sleep(forTimeInterval: 0.2)
        return true
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
        var request = URLRequest(url: healthURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 5.0)
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
        _ = semaphore.wait(timeout: .now() + 6.0)
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

// MARK: - Service → app event stream (Server-Sent Events over loopback)

/// Subscribes to /api/local/events and reconnects with backoff. Events arrive
/// on the main queue as (type, JSON object).
final class ShellEventStream: NSObject, URLSessionDataDelegate {
    private let url: URL
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var retryDelay: TimeInterval = 1
    private var stopped = false
    var onEvent: ((String, [String: Any]) -> Void)?

    init(port: String, capabilities: [String]) {
        var components = URLComponents(string: "http://localhost:\(port)/api/local/events")!
        components.queryItems = [URLQueryItem(name: "capabilities", value: capabilities.joined(separator: ","))]
        url = components.url!
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45 // heartbeats arrive every 15 s
        config.timeoutIntervalForResource = .infinity
        session = URLSession(configuration: config, delegate: self, delegateQueue: OperationQueue())
    }

    func start() {
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        task?.cancel()
        session.invalidateAndCancel()
    }

    private func connect() {
        guard !stopped else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 45)
        request.setValue("1", forHTTPHeaderField: "X-AirBridge-Shell")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        buffer = Data()
        task = session.dataTask(with: request)
        task?.resume()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        if ok { retryDelay = 1 }
        completionHandler(ok ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        let separator = Data("\n\n".utf8)
        while let range = buffer.range(of: separator) {
            let block = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            guard let text = String(data: block, encoding: .utf8) else { continue }
            var type = "message"
            var payload = ""
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                if line.hasPrefix("event: ") { type = String(line.dropFirst(7)) }
                else if line.hasPrefix("data: ") { payload += String(line.dropFirst(6)) }
            }
            guard !payload.isEmpty, let json = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] else { continue }
            DispatchQueue.main.async { self.onEvent?(type, json) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !stopped else { return }
        let delay = retryDelay
        retryDelay = min(10, retryDelay * 2)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }
}

// MARK: - Local service API (loopback only)

enum LocalAPI {
    static func request(port: String, path: String, method: String = "GET", timeout: TimeInterval = 120, completion: @escaping (Int, [String: Any]?) -> Void) {
        guard let url = URL(string: "http://localhost:\(port)\(path)") else { completion(0, nil); return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { completion(status, json) }
        }.resume()
    }

    static func raw(port: String, path: String, completion: @escaping (Data?) -> Void) {
        guard let url = URL(string: "http://localhost:\(port)\(path)") else { completion(nil); return }
        URLSession.shared.dataTask(with: URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { completion(ok ? data : nil) }
        }.resume()
    }
}

// MARK: - Open at Login (launchd agent; no signed helper / SMAppService needed)

enum LoginItem {
    static let label = "com.airbridge.app"
    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }
    static var isEnabled: Bool { FileManager.default.fileExists(atPath: plistURL.path) }

    @discardableResult
    static func setEnabled(_ enabled: Bool, executable: String) -> Bool {
        let domain = "gui/\(getuid())"
        _ = run("/bin/launchctl", ["bootout", "\(domain)/\(label)"])
        if !enabled {
            try? FileManager.default.removeItem(at: plistURL)
            return true
        }
        // Start at login, hidden; restart after a crash (non-zero exit) but not
        // after Quit (exit 0). launchd throttles a crash loop to one start / 10 s.
        let plist: [String: Any] = [
            "Label": label,
            "ProgramArguments": [executable, "--background"],
            "RunAtLoad": true,
            "KeepAlive": ["SuccessfulExit": false],
            "ThrottleInterval": 10,
            "ProcessType": "Interactive",
            "LimitLoadToSessionType": "Aqua",
        ]
        do {
            try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: .atomic)
        } catch {
            return false
        }
        // Loading runs it now; the second instance hands over to this one and exits 0.
        return run("/bin/launchctl", ["bootstrap", domain, plistURL.path]) == 0 || isEnabled
    }

    private static func run(_ path: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var supervisor: ServiceSupervisor!
    var events: ShellEventStream?
    var pageLoaded = false
    var loginMenuItem: NSMenuItem?
    var updateMenuItem: NSMenuItem?
    /// Launched at login (or relaunched while hidden): no window until asked.
    let launchedInBackground = CommandLine.arguments.contains("--background")
    var relaunching = false

    private static func resource(_ name: String) -> String? {
        guard let dir = Bundle.main.resourcePath else { return nil }
        let path = (dir as NSString).appendingPathComponent(name)
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private static func configuredPort() -> String {
        if let env = ProcessInfo.processInfo.environment["PORT"], !env.isEmpty { return env }
        // Prebuilt (signed) bundles are never modified after install: per-user settings live in ~/.airbridge.
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".airbridge/port")
        if let text = try? String(contentsOf: file, encoding: .utf8) {
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if let n = Int(value), n > 0, n < 65536 { return value }
        }
        return resource("port") ?? "3000"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One app per user: a login-item start while the app already runs just exits.
        if let id = Bundle.main.bundleIdentifier {
            // Launch Services can briefly list an instance that was just killed: check the process.
            let others = NSRunningApplication.runningApplications(withBundleIdentifier: id).filter {
                $0.processIdentifier != getpid() && !$0.isTerminated && kill($0.processIdentifier, 0) == 0
            }
            if let other = others.first {
                if !launchedInBackground { other.activate(options: [.activateIgnoringOtherApps]) }
                exit(0)
            }
        }

        let port = AppDelegate.configuredPort()
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        // Release bundles ship the service inside the app; installer-built ones point at ~/.local/bin.
        var binaryPath = AppDelegate.resource("binary-path") ?? "\(home)/.local/bin/AirBridge"
        var appBundlePath: String? = nil
        if let res = Bundle.main.resourcePath {
            let embedded = (res as NSString).appendingPathComponent("airbridge-server")
            if FileManager.default.isExecutableFile(atPath: embedded) {
                binaryPath = embedded
                appBundlePath = Bundle.main.bundlePath
            }
        }

        // 1. Status Bar Menu Item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.title = "A"
            button.toolTip = "AirBridge — Fast E2EE File Transfer"

            let menu = NSMenu()
            menu.addItem(NSMenuItem(title: "Open AirBridge", action: #selector(showWindow), keyEquivalent: "o"))
            menu.addItem(NSMenuItem(title: "Restart AirBridge Service", action: #selector(restartService), keyEquivalent: "r"))
            menu.addItem(NSMenuItem.separator())
            let update = NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "u")
            menu.addItem(update)
            updateMenuItem = update
            let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLoginItem), keyEquivalent: "")
            login.state = LoginItem.isEnabled ? .on : .off
            menu.addItem(login)
            loginMenuItem = login
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Copy Diagnostics", action: #selector(copyDiagnostics), keyEquivalent: "d"))
            menu.addItem(NSMenuItem(title: "Show Service Log", action: #selector(showLog), keyEquivalent: "l"))
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
        supervisor = ServiceSupervisor(port: port, binaryPath: binaryPath, appBundlePath: appBundlePath)
        supervisor.onServiceReady = { [weak self] in self?.loadUI() }
        supervisor.start()

        // 5. Native notifications + lifecycle events from the service.
        setUpEventStream(port: port)

        if !launchedInBackground {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: Event stream / notifications

    private var canUseUserNotifications: Bool {
        Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app")
    }

    private var eventPort = ""

    private func startEventStream(notifications: Bool) {
        events?.stop()
        // Without notification permission the service keeps using osascript.
        let caps = notifications ? ["notification", "lifecycle"] : ["lifecycle"]
        let stream = ShellEventStream(port: eventPort, capabilities: caps)
        stream.onEvent = { [weak self] type, json in self?.handleServiceEvent(type, json) }
        stream.start()
        events = stream
        supervisor.log("event stream started (\(caps.joined(separator: ",")))")
    }

    private func setUpEventStream(port: String) {
        eventPort = port
        // Lifecycle events (relaunch after an update) must never wait for the
        // user to answer the notification prompt: subscribe right away.
        startEventStream(notifications: false)
        guard canUseUserNotifications else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let upgrade: () -> Void = { [weak self] in
            DispatchQueue.main.async {
                guard let self = self, !self.relaunching else { return }
                self.startEventStream(notifications: true)
            }
        }
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional:
                upgrade()
            case .denied:
                self.supervisor.log("notifications are turned off for AirBridge in System Settings; using osascript")
            default:
                // Completes only when the user answers the prompt (possibly much later).
                center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    if let error = error { self.supervisor.log("notifications unavailable: \(error.localizedDescription)") }
                    if granted { upgrade() }
                }
            }
        }
    }

    private func handleServiceEvent(_ type: String, _ json: [String: Any]) {
        switch type {
        case "notification":
            postNotification(title: json["title"] as? String ?? "AirBridge", body: json["body"] as? String ?? "", appName: json["appName"] as? String)
        case "update-installed":
            let version = json["version"] as? String ?? ""
            if json["relaunch"] as? Bool == true { relaunchAfterUpdate(version: version) }
        default:
            break
        }
    }

    private func postNotification(title: String, body: String, appName: String?) {
        guard canUseUserNotifications else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        if let app = appName, !app.isEmpty, app != "AirBridge" { content.subtitle = app }
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error { self.supervisor.log("notification failed: \(error.localizedDescription)") }
        }
    }

    // Show banners while AirBridge is frontmost too.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if #available(macOS 11.0, *) { completionHandler([.banner, .sound]) } else { completionHandler([.alert, .sound]) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { self.showWindow() }
        completionHandler()
    }

    /// The service replaced this app bundle with a verified newer one: start it and quit.
    private func relaunchAfterUpdate(version: String) {
        guard !relaunching else { return }
        relaunching = true
        supervisor.log("update \(version) installed; relaunching the app")
        supervisor.detach()
        events?.stop()
        let bundle = Bundle.main.bundlePath
        let hidden = !window.isVisible
        let script = "while kill -0 \(getpid()) 2>/dev/null; do sleep 0.2; done; sleep 0.5; /usr/bin/open -n \"$0\" \(hidden ? "--args --background" : "")"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script, bundle]
        try? p.run()
        NSApp.terminate(nil)
    }

    // MARK: Menu actions

    @objc func checkForUpdates() {
        updateMenuItem?.isEnabled = false
        updateMenuItem?.title = "Checking for Updates…"
        LocalAPI.request(port: supervisor.port, path: "/api/update/check", method: "POST", timeout: 600) { [weak self] status, json in
            guard let self = self else { return }
            self.updateMenuItem?.isEnabled = true
            self.updateMenuItem?.title = "Check for Updates…"
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "AirBridge"
            guard status == 200, let json = json else {
                alert.informativeText = status == 404
                    ? "This copy of AirBridge is updated by re-running the installer."
                    : "Could not check for updates. Is AirBridge running?"
                alert.runModal()
                return
            }
            let current = json["current"] as? String ?? "?"
            let latest = json["latest"] as? String ?? current
            let state = json["state"] as? String ?? ""
            if state == "ready" {
                alert.messageText = "AirBridge \(latest) is ready to install"
                alert.informativeText = "You have \(current). The update was downloaded and verified (SHA-256). AirBridge restarts for a few seconds."
                alert.addButton(withTitle: "Install and Restart")
                alert.addButton(withTitle: "Later")
                if alert.runModal() == .alertFirstButtonReturn {
                    LocalAPI.request(port: self.supervisor.port, path: "/api/update/install", method: "POST") { status, json in
                        if status != 200 || (json?["state"] as? String) == "error" {
                            let failed = NSAlert()
                            failed.messageText = "The update could not be installed"
                            failed.informativeText = json?["error"] as? String ?? "Unknown error"
                            failed.runModal()
                        }
                    }
                }
            } else if state == "up-to-date" {
                alert.informativeText = "AirBridge \(current) is the latest version."
                alert.runModal()
            } else {
                alert.informativeText = (json["error"] as? String).map { "Update check failed: \($0)" } ?? (json["reason"] as? String ?? "No update available.")
                alert.runModal()
            }
        }
    }

    @objc func toggleLoginItem() {
        let enable = !LoginItem.isEnabled
        let exe = Bundle.main.executablePath ?? CommandLine.arguments[0]
        if LoginItem.setEnabled(enable, executable: exe) {
            loginMenuItem?.state = enable ? .on : .off
        }
    }

    @objc func copyDiagnostics() {
        LocalAPI.raw(port: supervisor.port, path: "/api/diagnostics") { [weak self] data in
            guard let self = self else { return }
            var text = "AirBridge diagnostics (macOS app)\n"
            text += "app: \(Bundle.main.bundlePath) pid \(getpid())\n"
            text += "macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)\n"
            text += "service binary: \(self.supervisor.binaryPath) (\(self.supervisor.installedVersion ?? "unknown version"))\n"
            text += "open at login: \(LoginItem.isEnabled)\n"
            if let data = data, let json = String(data: data, encoding: .utf8) {
                text += "```json\n\(json)\n```\n"
            } else {
                text += "service: not reachable on port \(self.supervisor.port)\n"
                let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".airbridge/server.log")
                if let tail = try? String(contentsOf: log, encoding: .utf8) {
                    text += "--- server.log (tail)\n" + tail.split(separator: "\n").suffix(80).joined(separator: "\n") + "\n"
                }
            }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            self.postNotification(title: "Diagnostics copied", body: "Paste them into your support request or GitHub issue.", appName: nil)
        }
    }

    @objc func showLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".airbridge/server.log")
        if !NSWorkspace.shared.open(log) {
            NSWorkspace.shared.activateFileViewerSelecting([log])
        }
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
        events?.stop()
        // After an update the service restarts itself from the new build.
        if !relaunching { supervisor?.stop() }
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
