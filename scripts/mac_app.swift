import AppKit
import WebKit
import Foundation
import UserNotifications
import CoreBluetooth
import AVFoundation

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

enum LoopbackHTTP {
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config)
    }()
}

private func airbridgeStateDir() -> URL {
    if let envHome = ProcessInfo.processInfo.environment["HOME"], !envHome.isEmpty {
        return URL(fileURLWithPath: envHome, isDirectory: true).appendingPathComponent(".airbridge")
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".airbridge")
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
    private let logLock = NSLock()
    private var _quitting = false
    private var _ownPid: Int32 = 0
    private var _earlyExits = 0
    /// Set from the main thread on quit while the supervisor queue may be busy.
    private var quitting: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _quitting }
        set { stateLock.lock(); _quitting = newValue; stateLock.unlock() }
    }
    private(set) var ownPid: Int32 {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _ownPid }
        set { stateLock.lock(); _ownPid = newValue; stateLock.unlock() }
    }
    /// First failed health check measured with a monotonic clock. `Date` advances
    /// while a Mac sleeps; counting that time used to make the watchdog kill a
    /// healthy service immediately after wake before its event loop resumed.
    private var unresponsiveSince: DispatchTime?
    /// Crash-loop backoff: consecutive starts that exited early, and when the next start may happen.
    private(set) var earlyExits: Int {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _earlyExits }
        set { stateLock.lock(); _earlyExits = newValue; stateLock.unlock() }
    }
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
        stateLock.lock()
        _quitting = true
        let pid = _ownPid
        _ownPid = 0
        stateLock.unlock()
        // Never block quitting behind a start-up wait on the supervisor queue.
        if pid > 1 {
            kill(pid, SIGTERM)
            for _ in 0..<20 {
                if kill(pid, 0) != 0 { break }
                Thread.sleep(forTimeInterval: 0.1)
            }
            if kill(pid, 0) == 0 {
                kill(pid, SIGKILL)
            }
        }
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

        if unresponsiveSince == nil { unresponsiveSince = .now() }
        let start = unresponsiveSince!.uptimeNanoseconds
        let current = DispatchTime.now().uptimeNanoseconds
        let silentFor = current >= start ? TimeInterval(current - start) / 1_000_000_000 : 0
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
        unresponsiveSince = .now()
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
        let task = LoopbackHTTP.session.dataTask(with: request) { data, response, error in
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
        airbridgeStateDir().appendingPathComponent("server.log")
    }

    private func logHandle() -> FileHandle? {
        logLock.lock()
        defer { logLock.unlock() }
        return unlockedLogHandle()
    }

    private func unlockedLogHandle() -> FileHandle? {
        let url = logURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let size = attrs[.size] as? NSNumber, size.intValue > 5_000_000 {
            try? FileManager.default.removeItem(at: url)
        }
        let fd = open(url.path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        guard fd >= 0 else { return nil }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    func log(_ message: String) {
        logLock.lock()
        defer { logLock.unlock() }
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] [app] \(message)\n"
        if let handle = unlockedLogHandle(), let data = line.data(using: .utf8) {
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
    private let lock = NSLock()
    private let retryQueue = DispatchQueue(label: "airbridge.events")
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var retryDelay: TimeInterval = 1
    private var stopped = false
    private var _connected = false
    private var _lastError: String?
    var onEvent: ((String, [String: Any]) -> Void)?

    var isConnected: Bool {
        lock.lock(); defer { lock.unlock() }; return _connected
    }

    var lastError: String? {
        lock.lock(); defer { lock.unlock() }; return _lastError
    }

    init(port: String, capabilities: [String]) {
        var components = URLComponents(string: "http://localhost:\(port)/api/local/events")!
        components.queryItems = [URLQueryItem(name: "capabilities", value: capabilities.joined(separator: ","))]
        url = components.url!
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 45 // heartbeats arrive every 15 s
        config.timeoutIntervalForResource = .infinity
        session = URLSession(configuration: config, delegate: self, delegateQueue: OperationQueue())
    }

    func start() {
        lock.lock()
        stopped = false
        lock.unlock()
        connect()
    }

    func stop() {
        lock.lock()
        stopped = true
        _connected = false
        let currentTask = task
        task = nil
        lock.unlock()
        currentTask?.cancel()
        session.invalidateAndCancel()
    }

    func reconnectNowIfDisconnected() {
        lock.lock()
        let shouldConnect = !stopped && !_connected && task == nil
        if shouldConnect {
            retryDelay = 1
        }
        lock.unlock()
        if shouldConnect {
            retryQueue.async { [weak self] in self?.connect() }
        }
    }

    private func connect() {
        lock.lock()
        if stopped || task != nil {
            lock.unlock()
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 45)
        request.setValue("1", forHTTPHeaderField: "X-AirBridge-Shell")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        buffer = Data()
        let newTask = session.dataTask(with: request)
        task = newTask
        lock.unlock()
        newTask.resume()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let ok = code == 200
        lock.lock()
        if ok {
            retryDelay = 1
            _connected = true
            _lastError = nil
        } else {
            _connected = false
            _lastError = "HTTP \(code)"
        }
        lock.unlock()
        completionHandler(ok ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        buffer.append(data)
        let separator = Data("\n\n".utf8)
        var eventsToDispatch: [(String, [String: Any])] = []
        while let range = buffer.range(of: separator) {
            let block = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            guard let text = String(data: block, encoding: .utf8) else { continue }
            var type = "message"
            var dataLines: [String] = []
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                if line.hasPrefix("event: ") { type = String(line.dropFirst(7)) }
                else if line.hasPrefix("data: ") { dataLines.append(String(line.dropFirst(6))) }
                else if line.hasPrefix("data:") { dataLines.append(String(line.dropFirst(5))) }
            }
            let payload = dataLines.joined(separator: "\n")
            guard !payload.isEmpty, let json = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] else { continue }
            eventsToDispatch.append((type, json))
        }
        lock.unlock()
        for (type, json) in eventsToDispatch {
            DispatchQueue.main.async { self.onEvent?(type, json) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        if self.task === task {
            self.task = nil
        }
        _connected = false
        if let error = error {
            _lastError = error.localizedDescription
        }
        if stopped {
            lock.unlock()
            return
        }
        let delay = retryDelay
        retryDelay = min(10, retryDelay * 2)
        lock.unlock()
        retryQueue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }
}

// MARK: - Hotspot handoff over Bluetooth LE (GATT peripheral)

/// Lets a paired phone hand over its hotspot when the two share no network.
///
/// The phone reads the rotating tag (proves this is the computer it paired
/// with), writes its sealed offer, then follows the status characteristic.
/// This app only shuttles opaque bytes: the service opens and verifies the
/// offer (sealed to its key, MACed with the pairing code) and asks for consent.
/// Nothing identifying is advertised: just the service UUID, no name.
final class HandoffPeripheral: NSObject, CBPeripheralManagerDelegate {
    private let port: String
    private let log: (String) -> Void
    private var manager: CBPeripheralManager?
    private var tagChar: CBMutableCharacteristic?
    private var offerChar: CBMutableCharacteristic?
    private var statusChar: CBMutableCharacteristic?
    private var serviceUUID: CBUUID?
    private var tag = Data()
    private var status = Data("{\"s\":\"idle\",\"r\":\"\"}".utf8)
    private var refreshTimer: Timer?
    private var pollTimer: Timer?
    private var currentOffer: String?
    private var advertisingWanted = false
    private var stopped = false
    private var warnedNoUsageString = false
    private var pendingStatusUpdate = false

    var bleStateDescription: String {
        guard let manager = manager else {
            return warnedNoUsageString ? "disabled-no-usage-key" : "uninitialized"
        }
        switch manager.state {
        case .poweredOn: return "poweredOn"
        case .poweredOff: return "poweredOff"
        case .unauthorized: return "unauthorized"
        case .unsupported: return "unsupported"
        case .resetting: return "resetting"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }

    var isAdvertisingActive: Bool {
        manager?.isAdvertising ?? false
    }

    init(port: String, log: @escaping (String) -> Void) {
        self.port = port
        self.log = log
        super.init()
    }

    func start() {
        stopped = false
        refreshBeacon()
    }

    func stop() {
        stopped = true
        refreshTimer?.invalidate()
        pollTimer?.invalidate()
        manager?.stopAdvertising()
        manager?.removeAllServices()
    }

    private static func shellRequest(port: String, path: String, method: String = "GET", body: [String: Any]? = nil, completion: @escaping (Int, [String: Any]?) -> Void) {
        guard let url = URL(string: "http://localhost:\(port)\(path)") else { completion(0, nil); return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
        req.httpMethod = method
        req.setValue("1", forHTTPHeaderField: "X-AirBridge-Shell")
        if let body = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        LoopbackHTTP.session.dataTask(with: req) { data, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { completion(code, json) }
        }.resume()
    }

    /// Fetches the current tag; reschedules itself for the next time window.
    private func refreshBeacon() {
        guard !stopped else { return }
        HandoffPeripheral.shellRequest(port: port, path: "/api/local/handoff/beacon") { [weak self] code, json in
            guard let self = self, !self.stopped else { return }
            var next: TimeInterval = code == 0 ? 3 : 60
            if code == 200, let json = json, json["enabled"] as? Bool == true, json["shared"] as? Bool == true,
               let tagB64 = json["tag"] as? String, let tag = Data(base64Encoded: tagB64),
               let uuids = json["uuids"] as? [String: String] {
                self.tag = tag
                self.ensureManager(uuids: uuids)
                self.advertisingWanted = true
                self.startAdvertisingIfReady()
                if let ms = json["refreshInMs"] as? Double { next = max(5, min(ms / 1000, 15 * 60)) }
            } else {
                // Turned off, nothing shared yet, or the service is restarting.
                self.advertisingWanted = false
                self.manager?.stopAdvertising()
            }
            self.refreshTimer?.invalidate()
            self.refreshTimer = Timer.scheduledTimer(withTimeInterval: next, repeats: false) { [weak self] _ in self?.refreshBeacon() }
        }
    }

    private func ensureManager(uuids: [String: String]) {
        // Without the usage string macOS terminates the app on first Bluetooth use
        // (e.g. an older locally assembled bundle): skip Bluetooth instead.
        guard Bundle.main.object(forInfoDictionaryKey: "NSBluetoothAlwaysUsageDescription") != nil else {
            if !warnedNoUsageString { log("handoff: this app bundle has no Bluetooth usage description; Bluetooth handoff disabled") }
            warnedNoUsageString = true
            return
        }
        guard manager == nil,
              let service = uuids["service"], let tagId = uuids["tag"], let offerId = uuids["offer"], let statusId = uuids["status"] else { return }
        serviceUUID = CBUUID(string: service)
        tagChar = CBMutableCharacteristic(type: CBUUID(string: tagId), properties: [.read], value: nil, permissions: [.readable])
        offerChar = CBMutableCharacteristic(type: CBUUID(string: offerId), properties: [.write], value: nil, permissions: [.writeable])
        statusChar = CBMutableCharacteristic(type: CBUUID(string: statusId), properties: [.read, .notify], value: nil, permissions: [.readable])
        // First use shows the macOS Bluetooth prompt (NSBluetoothAlwaysUsageDescription).
        manager = CBPeripheralManager(delegate: self, queue: nil)
        log("handoff: Bluetooth peripheral created")
    }

    private func startAdvertisingIfReady() {
        guard advertisingWanted, let manager = manager, manager.state == .poweredOn, let uuid = serviceUUID else { return }
        if !manager.isAdvertising {
            manager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [uuid]])
        }
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            guard let uuid = serviceUUID, let t = tagChar, let o = offerChar, let s = statusChar else { return }
            let service = CBMutableService(type: uuid, primary: true)
            service.characteristics = [t, o, s]
            peripheral.removeAllServices()
            peripheral.add(service)
        case .unauthorized:
            log("handoff: Bluetooth access denied for AirBridge (System Settings › Privacy & Security › Bluetooth)")
        case .poweredOff:
            log("handoff: Bluetooth is off")
        default:
            break
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error = error { log("handoff: GATT service failed: \(error.localizedDescription)"); return }
        startAdvertisingIfReady()
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error = error { log("handoff: advertising failed: \(error.localizedDescription)") }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        let uuid = request.characteristic.uuid
        let value: Data
        if uuid == tagChar?.uuid {
            value = tag
        } else if uuid == statusChar?.uuid {
            value = status
        } else {
            peripheral.respond(to: request, withResult: .attributeNotFound)
            return
        }
        guard request.offset <= value.count else {
            peripheral.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = value.subdata(in: request.offset..<value.count)
        peripheral.respond(to: request, withResult: .success)
    }

    /// Long writes arrive as several requests with offsets: reassemble them.
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        guard requests.allSatisfy({ $0.characteristic.uuid == offerChar?.uuid }) else {
            peripheral.respond(to: first, withResult: .writeNotPermitted)
            return
        }
        var envelope = Data()
        for r in requests.sorted(by: { $0.offset < $1.offset }) {
            guard let v = r.value, r.offset == envelope.count, envelope.count + v.count <= 512 else {
                peripheral.respond(to: first, withResult: .invalidAttributeValueLength)
                return
            }
            envelope.append(v)
        }
        peripheral.respond(to: first, withResult: .success)
        submit(envelope)
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        guard pendingStatusUpdate, let c = statusChar else { return }
        if peripheral.updateValue(status, for: c, onSubscribedCentrals: nil) {
            pendingStatusUpdate = false
        }
    }

    private func submit(_ envelope: Data) {
        setStatus(state: "pending", reason: "")
        HandoffPeripheral.shellRequest(port: port, path: "/api/local/handoff/offer", method: "POST", body: ["envelope": envelope.base64EncodedString()]) { [weak self] code, json in
            guard let self = self else { return }
            guard code == 200, let json = json, let id = json["id"] as? String else {
                self.setStatus(state: "failed", reason: "AirBridge on the computer isn't responding")
                return
            }
            self.currentOffer = id
            self.apply(json)
            self.pollTimer?.invalidate()
            self.pollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.poll() }
        }
    }

    private func poll() {
        guard let id = currentOffer else { pollTimer?.invalidate(); return }
        HandoffPeripheral.shellRequest(port: port, path: "/api/local/handoff/offer/\(id)") { [weak self] code, json in
            guard let self = self, self.currentOffer == id else { return }
            if code == 200, let json = json { self.apply(json) } else if code == 404 { self.pollTimer?.invalidate() }
        }
    }

    private func apply(_ view: [String: Any]) {
        let state = view["state"] as? String ?? "failed"
        setStatus(state: state, reason: view["reason"] as? String ?? "")
        // The phone stops listening at "joined"; the session takes over on the hotspot.
        if state != "pending" && state != "joining" { pollTimer?.invalidate() }
    }

    private func setStatus(state: String, reason: String) {
        let body: [String: String] = ["s": state, "r": String(reason.prefix(120))]
        guard let data = try? JSONSerialization.data(withJSONObject: body), data != status else { return }
        status = data
        if let c = statusChar, let mgr = manager {
            pendingStatusUpdate = !mgr.updateValue(data, for: c, onSubscribedCentrals: nil)
        }
    }
}

// MARK: - Local service API (loopback only)

enum LocalAPI {
    static func request(port: String, path: String, method: String = "GET", timeout: TimeInterval = 120, completion: @escaping (Int, [String: Any]?) -> Void) {
        guard let url = URL(string: "http://localhost:\(port)\(path)") else { completion(0, nil); return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        LoopbackHTTP.session.dataTask(with: req) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { completion(status, json) }
        }.resume()
    }

    static func raw(port: String, path: String, completion: @escaping (Data?) -> Void) {
        guard let url = URL(string: "http://localhost:\(port)\(path)") else { completion(nil); return }
        LoopbackHTTP.session.dataTask(with: URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)) { data, response, _ in
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

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var supervisor: ServiceSupervisor!
    var events: ShellEventStream?
    var handoffPeripheral: HandoffPeripheral?
    var pageLoaded = false
    var webViewLastError: String?
    var notificationAuthStatus = "notDetermined"
    var loginMenuItem: NSMenuItem?
    var updateMenuItem: NSMenuItem?
    /// "AirBridge 0.0.6" at the top of the menu-bar menu (like any Mac utility).
    var versionMenuItem: NSMenuItem?
    /// Panel to open once the page has loaded (Contacts / Calls / Screen / Settings).
    var pendingPanel: String?
    /// Launched at login (or relaunched while hidden): no window until asked.
    let launchedInBackground = CommandLine.arguments.contains("--background")
    var relaunching = false

    static func sanitizeDownloadFilename(_ raw: String) -> String {
        let normalized = raw.replacingOccurrences(of: "\\", with: "/")
        let base = (normalized as NSString).lastPathComponent
        var cleaned = ""
        for scalar in base.unicodeScalars {
            let v = scalar.value
            if v < 0x20 || v == 0x7F || ["/", "\\", ":", "<", ">", "\"", "|", "?", "*"].contains(Character(scalar)) {
                cleaned.append("_")
            } else {
                cleaned.append(Character(scalar))
            }
        }
        while cleaned.hasPrefix(".") {
            cleaned.removeFirst()
        }
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "." || trimmed == ".." {
            return "airbridge-download"
        }
        return String(trimmed.prefix(200))
    }

    static func uniqueDownloadDestination(in directory: URL, suggestedFilename: String) -> URL {
        let safeName = sanitizeDownloadFilename(suggestedFilename)
        let ext = (safeName as NSString).pathExtension
        let stem = (safeName as NSString).deletingPathExtension
        let dirStandard = directory.standardizedFileURL.path
        for index in 0..<10_000 {
            let candidateName: String
            if index == 0 {
                candidateName = safeName
            } else if ext.isEmpty {
                candidateName = "\(stem) (\(index))"
            } else {
                candidateName = "\(stem) (\(index)).\(ext)"
            }
            let candidateURL = directory.appendingPathComponent(candidateName)
            let candidateStandard = candidateURL.standardizedFileURL.path
            guard candidateStandard.hasPrefix(dirStandard + "/") else {
                continue
            }
            if !FileManager.default.fileExists(atPath: candidateStandard) {
                return candidateURL
            }
        }
        return directory.appendingPathComponent("airbridge-download-\(Int(Date().timeIntervalSince1970))")
    }

    static func scrubDiagnosticsText(_ input: String) -> String {
        var out = input
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if !home.isEmpty {
            out = out.replacingOccurrences(of: home, with: "~")
        }
        let replacements: [(String, String)] = [
            ("/Users/[A-Za-z0-9._-]+", "~"),
            ("([?&](?:pair|token|ca|key)=)[^&\\s\"']+", "$1<redacted>"),
            ("/api/beam/[A-Za-z0-9_-]+", "/api/beam/<redacted>"),
            ("(\"?(?:pairCode|token|password|psk|ssid)\"?\\s*:\\s*\")[^\"]*\"", "$1<redacted>\""),
            ("([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", "<redacted-mac>"),
            ("Join “[^”]+”", "Join “<redacted-ssid>”"),
            ("Joining “[^”]+”", "Joining “<redacted-ssid>”"),
            ("Connected to “[^”]+”", "Connected to “<redacted-ssid>”"),
        ]
        for (pattern, template) in replacements {
            if let regex = try? NSRegularExpression(pattern: pattern, options: []) {
                let range = NSRange(out.startIndex..<out.endIndex, in: out)
                out = regex.stringByReplacingMatches(in: out, options: [], range: range, withTemplate: template)
            }
        }
        return out
    }

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
        let file = airbridgeStateDir().appendingPathComponent("port")
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
            button.setAccessibilityLabel("AirBridge")

            let menu = NSMenu()
            menu.delegate = self
            let version = NSMenuItem(title: AppDelegate.versionLabel(nil), action: nil, keyEquivalent: "")
            version.isEnabled = false
            menu.addItem(version)
            versionMenuItem = version
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Open AirBridge", action: #selector(showWindow), keyEquivalent: "o"))
            // Phone on your computer: contacts, calls and screen sharing.
            menu.addItem(NSMenuItem(title: "Contacts", action: #selector(openContacts), keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "Calls", action: #selector(openCalls), keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "Screen Sharing", action: #selector(openScreenSharing), keyEquivalent: ""))
            menu.addItem(NSMenuItem.separator())
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

        buildMainMenu()
        refreshVersionLabels()

        // 2. Native macOS Window
        let rect = NSRect(x: 0, y: 0, width: 960, height: 720)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AirBridge"
        window.backgroundColor = NSColor.windowBackgroundColor
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.center()
        window.setFrameAutosaveName("AirBridgeMainWindow")
        window.minSize = NSSize(width: 480, height: 600)

        // 3. WKWebView (+ "Restart AirBridge" bridge for the page)
        let config = WKWebViewConfiguration()
        let bundleId = Bundle.main.bundleIdentifier ?? ""
        if bundleId.hasSuffix(".test") || bundleId.hasSuffix(".ci") || ProcessInfo.processInfo.environment["AIRBRIDGE_TEST_PORT"] != nil {
            config.websiteDataStore = .nonPersistent()
        }
        let developerExtrasEnabled = ProcessInfo.processInfo.environment["AIRBRIDGE_DEV_EXTRAS"] == "1"
        config.preferences.setValue(developerExtrasEnabled, forKey: "developerExtrasEnabled")
        if #available(macOS 12.3, *) {
            config.preferences.isElementFullscreenEnabled = true
        } else {
            config.preferences.setValue(true, forKey: "fullScreenEnabled")
        }
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "airbridgeShell")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView?.addSubview(webView)

        // 4. Supervise the service; (re)load the UI whenever it (re)starts.
        supervisor = ServiceSupervisor(port: port, binaryPath: binaryPath, appBundlePath: appBundlePath)
        supervisor.onServiceReady = { [weak self] in
            self?.loadUI()
            self?.refreshVersionLabels()
            self?.events?.reconnectNowIfDisconnected()
        }
        supervisor.start()

        // 5. Native notifications + lifecycle events from the service.
        setUpEventStream(port: port)

        // 6. Bluetooth path for hotspot handoff (starts Bluetooth only once a
        //    phone holds this computer's handoff keys).
        if ProcessInfo.processInfo.environment["AIRBRIDGE_HANDOFF"] != "0" {
            let peripheral = HandoffPeripheral(port: port) { [weak self] message in self?.supervisor.log(message) }
            peripheral.start()
            handoffPeripheral = peripheral
        }

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
        let caps = notifications ? ["notification", "lifecycle", "handoff"] : ["lifecycle"]
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
        registerNotificationCategories()
        let upgrade: () -> Void = { [weak self] in
            DispatchQueue.main.async {
                guard let self = self, !self.relaunching else { return }
                self.startEventStream(notifications: true)
            }
        }
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized:
                DispatchQueue.main.async { self.notificationAuthStatus = "authorized" }
                upgrade()
            case .provisional:
                DispatchQueue.main.async { self.notificationAuthStatus = "provisional" }
                upgrade()
            case .denied:
                DispatchQueue.main.async { self.notificationAuthStatus = "denied" }
                self.supervisor.log("notifications are turned off for AirBridge in System Settings; using osascript")
            default:
                DispatchQueue.main.async { self.notificationAuthStatus = "notDetermined" }
                // Completes only when the user answers the prompt (possibly much later).
                center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    DispatchQueue.main.async {
                        self.notificationAuthStatus = granted ? "authorized" : "denied"
                    }
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
        case "handoff-request":
            postHandoffRequest(json)
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

    private static let handoffCategory = "AIRBRIDGE_HANDOFF"

    private func registerNotificationCategories() {
        let join = UNNotificationAction(identifier: "join", title: "Join", options: [])
        let always = UNNotificationAction(identifier: "always", title: "Always join paired phones", options: [])
        let decline = UNNotificationAction(identifier: "decline", title: "Not now", options: [.destructive])
        let category = UNNotificationCategory(identifier: AppDelegate.handoffCategory, actions: [join, always, decline], intentIdentifiers: [], options: [.customDismissAction])
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// A paired phone offers its hotspot: ask with actionable buttons (also answerable in the window).
    private func postHandoffRequest(_ json: [String: Any]) {
        guard canUseUserNotifications, let id = json["id"] as? String else { return }
        let device = (json["deviceName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Your phone"
        let ssid = json["ssid"] as? String ?? ""
        let content = UNMutableNotificationContent()
        content.title = "\(device) offers its hotspot"
        content.body = "Join “\(ssid)” for a direct link? Your normal Wi-Fi comes back when the phone stops the hotspot."
        content.sound = .default
        content.categoryIdentifier = AppDelegate.handoffCategory
        content.userInfo = ["handoffId": id]
        let request = UNNotificationRequest(identifier: "handoff-\(id)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error { self.supervisor.log("handoff notification failed: \(error.localizedDescription)") }
        }
    }

    private func respondToHandoff(id: String, allow: Bool, always: Bool) {
        guard let url = URL(string: "http://localhost:\(eventPort)/api/handoff/\(id)/respond") else { return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["allow": allow, "always": always])
        LoopbackHTTP.session.dataTask(with: req) { _, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code != 200 { self.supervisor.log("handoff response failed (HTTP \(code))") }
        }.resume()
    }

    // Show banners while AirBridge is frontmost too.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if #available(macOS 11.0, *) { completionHandler([.banner, .sound]) } else { completionHandler([.alert, .sound]) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let content = response.notification.request.content
        if content.categoryIdentifier == AppDelegate.handoffCategory, let id = content.userInfo["handoffId"] as? String {
            switch response.actionIdentifier {
            case "join": respondToHandoff(id: id, allow: true, always: false)
            case "always": respondToHandoff(id: id, allow: true, always: true)
            case "decline": respondToHandoff(id: id, allow: false, always: false)
            // Dismissed: leave it pending; it can still be answered in the window until it expires.
            case UNNotificationDismissActionIdentifier: break
            // Body click: answer in the window.
            default: DispatchQueue.main.async { self.showWindow() }
            }
            completionHandler()
            return
        }
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
            let logFile = airbridgeStateDir().appendingPathComponent("server.log")
            let rawLog = (try? String(contentsOf: logFile, encoding: .utf8)) ?? ""
            let appLogTail = rawLog
                .split(separator: "\n")
                .filter { $0.contains("[app]") }
                .suffix(40)
                .map { AppDelegate.scrubDiagnosticsText(String($0)) }
            let policyName: String
            switch NSApp.activationPolicy() {
            case .regular: policyName = "regular"
            case .accessory: policyName = "accessory"
            case .prohibited: policyName = "prohibited"
            @unknown default: policyName = "unknown"
            }
            let macAppBlock: [String: Any] = [
                "bundleId": Bundle.main.bundleIdentifier ?? "com.airbridge.launcher",
                "shortVersion": self.appVersion ?? "unknown",
                "bundlePath": AppDelegate.scrubDiagnosticsText(Bundle.main.bundlePath),
                "serviceBinaryPath": AppDelegate.scrubDiagnosticsText(self.supervisor.binaryPath),
                "launchedInBackground": self.launchedInBackground,
                "activationPolicy": policyName,
                "notificationAuthStatus": self.notificationAuthStatus,
                "bleState": self.handoffPeripheral?.bleStateDescription ?? "disabled",
                "bleAdvertising": self.handoffPeripheral?.isAdvertisingActive ?? false,
                "sseConnected": self.events?.isConnected ?? false,
                "sseLastError": self.events?.lastError as Any,
                "webViewLoaded": self.pageLoaded,
                "webViewLastError": self.webViewLastError as Any,
                "elementFullscreenEnabled": true,
                "mediaAutoplayUnrestricted": true,
                "microphonePermissionPolicy": "loopback-only",
                "microphoneAuthStatus": AppDelegate.microphoneAuthStatusString(),
                "launchAgentPresent": LoginItem.isEnabled,
                "supervisorEarlyExits": self.supervisor.earlyExits,
                "appLogTail": appLogTail,
            ]
            var text = "AirBridge diagnostics (macOS app)\n"
            text += "app: \(AppDelegate.scrubDiagnosticsText(Bundle.main.bundlePath)) pid \(getpid())\n"
            text += "macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)\n"
            text += "service binary: \(AppDelegate.scrubDiagnosticsText(self.supervisor.binaryPath)) (\(self.supervisor.installedVersion ?? "unknown version"))\n"
            text += "open at login: \(LoginItem.isEnabled)\n"
            if let macAppData = try? JSONSerialization.data(withJSONObject: ["macApp": macAppBlock], options: [.prettyPrinted, .sortedKeys]),
               let macAppJson = String(data: macAppData, encoding: .utf8) {
                text += "```json\n\(AppDelegate.scrubDiagnosticsText(macAppJson))\n```\n"
            }
            if let data = data, let json = String(data: data, encoding: .utf8) {
                text += "```json\n\(AppDelegate.scrubDiagnosticsText(json))\n```\n"
            } else {
                text += "service: not reachable on port \(self.supervisor.port)\n"
                if !rawLog.isEmpty {
                    let scrubbedTail = AppDelegate.scrubDiagnosticsText(
                        rawLog.split(separator: "\n").suffix(80).joined(separator: "\n")
                    )
                    text += "--- server.log (tail)\n" + scrubbedTail + "\n"
                }
            }
            let scrubbedText = AppDelegate.scrubDiagnosticsText(text)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(scrubbedText, forType: .string)
            self.postNotification(title: "Diagnostics copied", body: "Paste them into your support request or GitHub issue.", appName: nil)
        }
    }

    @objc func showLog() {
        let log = airbridgeStateDir().appendingPathComponent("server.log")
        if !NSWorkspace.shared.open(log) {
            NSWorkspace.shared.activateFileViewerSelecting([log])
        }
    }

    func loadUI() {
        guard let url = URL(string: "http://localhost:\(supervisor.port)") else { return }
        // Never show a cached page from an older build.
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
    }

    // MARK: Version + menus

    /// Bundle version (release / installer bundles), else the service's.
    var appVersion: String? {
        if let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String, !v.isEmpty { return v }
        return supervisor?.installedVersion
    }

    static func versionLabel(_ version: String?) -> String {
        guard let v = version, !v.isEmpty else { return "AirBridge" }
        return "AirBridge \(v)"
    }

    func refreshVersionLabels() {
        let label = AppDelegate.versionLabel(appVersion)
        versionMenuItem?.title = label
        statusItem?.button?.toolTip = "\(label) — Fast E2EE File Transfer"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        refreshVersionLabels()
    }

    /// Standard Mac menu bar: app menu (About shows the version), Edit (copy and
    /// paste inside the window), Phone (contacts, calls, screen) and Window.
    private func buildMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu(title: "AirBridge")
        appMenu.addItem(NSMenuItem(title: "About AirBridge", action: #selector(showAbout), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ","))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Hide AirBridge", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Quit AirBridge", action: #selector(terminateApp), keyEquivalent: "q"))
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(NSMenuItem.separator())
        edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = edit

        let phoneItem = NSMenuItem()
        main.addItem(phoneItem)
        let phone = NSMenu(title: "Phone")
        phone.addItem(NSMenuItem(title: "Contacts", action: #selector(openContacts), keyEquivalent: "1"))
        phone.addItem(NSMenuItem(title: "Calls", action: #selector(openCalls), keyEquivalent: "2"))
        phone.addItem(NSMenuItem(title: "Screen Sharing", action: #selector(openScreenSharing), keyEquivalent: "3"))
        phoneItem.submenu = phone

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    @objc func showAbout() {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        style.paragraphSpacing = 4

        let credits = NSMutableAttributedString(
            string: "Private, end-to-end encrypted file transfers, bidirectional text & photo clipboard sync, persistent contacts, two-way Mac call audio, and smooth H.264 screen sharing between Android and macOS.\n\n",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.labelColor,
                .paragraphStyle: style,
            ]
        )
        credits.append(NSAttributedString(
            string: "ECDH P-256 + AES-256-GCM · SPAKE2 Verified Pairing · Zero Cloud Accounts\n\n",
            attributes: [
                .font: NSFont.systemFont(ofSize: 10, weight: .medium),
                .foregroundColor: NSColor.secondaryLabelColor,
                .paragraphStyle: style,
            ]
        ))
        credits.append(NSAttributedString(
            string: "Created by Diganta Dey  ·  ",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.secondaryLabelColor,
                .paragraphStyle: style,
            ]
        ))
        credits.append(NSAttributedString(
            string: "airbridge.fyi",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .link: "https://airbridge.fyi/",
                .paragraphStyle: style,
            ]
        ))
        credits.append(NSAttributedString(
            string: "  ·  ",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.secondaryLabelColor,
                .paragraphStyle: style,
            ]
        ))
        credits.append(NSAttributedString(
            string: "GitHub",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .link: "https://github.com/DigantaDey/AirBridge",
                .paragraphStyle: style,
            ]
        ))

        var options: [NSApplication.AboutPanelOptionKey: Any] = [
            .applicationName: "AirBridge",
            .credits: credits,
        ]
        if let v = appVersion { options[.applicationVersion] = v; options[.version] = "" }
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: options)
    }

    @objc func openContacts() { openPanel("contacts") }
    @objc func openCalls() { openPanel("calls") }
    @objc func openScreenSharing() { openPanel("screen") }
    @objc func openSettings() { openPanel("settings") }

    /// Shows the window and opens a panel in the page (queued until it loads).
    func openPanel(_ panel: String) {
        pendingPanel = panel
        showWindow()
        flushPendingPanel()
    }

    private func flushPendingPanel() {
        guard pageLoaded, let panel = pendingPanel, ["contacts", "calls", "screen", "settings"].contains(panel) else { return }
        pendingPanel = nil
        // The page may still be mounting: it picks the request up on start.
        let js = "(window.__airbridgeOpenPanel || function (p) { window.__airbridgePendingPanel = p; })('\(panel)')"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    @objc func showWindow() {
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
        }
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
              message.frameInfo.isMainFrame,
              let host = webView.url?.host,
              ["localhost", "127.0.0.1", "::1"].contains(host),
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        if action == "restart-server" {
            supervisor.restart()
        } else if action == "copy-text",
                  let text = body["text"] as? String,
                  text.utf8.count <= 1_000_000 {
            // WKWebView's navigator.clipboard / execCommand support varies by
            // macOS release. Use AppKit's pasteboard from the trusted local UI.
            DispatchQueue.main.async {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        } else if action == "open-external",
                  let rawUrl = body["url"] as? String,
                  let url = URL(string: rawUrl),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" {
            DispatchQueue.main.async {
                if !NSWorkspace.shared.open(url) {
                    self.supervisor?.log("failed to open external URL: \(AppDelegate.scrubDiagnosticsText(rawUrl))")
                }
            }
        }
    }

    private func isLocalServiceURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1"].contains(host)
    }

    // --- Navigation state & external link routing ---
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel)
            return
        }
        if scheme == "mailto" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        if scheme == "http" || scheme == "https" {
            if !isLocalServiceURL(url) || navigationAction.targetFrame == nil {
                if !NSWorkspace.shared.open(url) {
                    supervisor?.log("failed to open external navigation URL")
                }
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            return
        }
        if scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" || scheme == "mailto" {
            if !NSWorkspace.shared.open(url) {
                supervisor?.log("failed to open popup URL in external browser")
            }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        webViewLastError = nil
        flushPendingPanel()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        pageLoaded = false
        webViewLastError = error.localizedDescription
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        webViewLastError = error.localizedDescription
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

    static func microphoneAuthStatusString() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        let host = origin.host.lowercased()
        let isLoopbackHost = host == "localhost" || host == "127.0.0.1" || host == "::1"
        let expectedPort = supervisor != nil ? (Int(supervisor.port) ?? 0) : 0
        guard type == .microphone && isLoopbackHost && expectedPort > 0 && origin.port == expectedPort else {
            decisionHandler(.deny)
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            decisionHandler(.grant)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async {
                    decisionHandler(granted ? .grant : .deny)
                }
            }
        case .denied, .restricted:
            supervisor?.log("microphone access denied in macOS System Settings")
            decisionHandler(.deny)
        @unknown default:
            decisionHandler(.deny)
        }
    }

    // --- WKDownloadDelegate Direct File Downloads ---
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let downloadsDir = home.appendingPathComponent("Downloads/AirBridge")
        do {
            try FileManager.default.createDirectory(at: downloadsDir, withIntermediateDirectories: true)
            let fileUrl = AppDelegate.uniqueDownloadDestination(in: downloadsDir, suggestedFilename: suggestedFilename)
            completionHandler(fileUrl)
        } catch {
            supervisor?.log("download destination creation failed: \(error.localizedDescription)")
            completionHandler(nil)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        supervisor?.log("download failed: \(error.localizedDescription)")
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate

// SIGTERM/SIGINT (logout, `kill`, Activity Monitor) → stop supervised service
// immediately on a background queue, then ask AppKit to terminate so a blocked
// main thread can never orphan the child service.
let signalQueue = DispatchQueue(label: "airbridge.signal")
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    source.setEventHandler {
        delegate.events?.stop()
        if !delegate.relaunching { delegate.supervisor?.stop() }
        DispatchQueue.main.async { NSApp.terminate(nil) }
        signalQueue.asyncAfter(deadline: .now() + 2.0) { _exit(0) }
    }
    source.resume()
    signalSources.append(source)
}
app.setActivationPolicy(delegate.launchedInBackground ? .accessory : .regular)
app.run()
