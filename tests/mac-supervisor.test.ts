// @vitest-environment node
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('macOS service watchdog & native app hardening (M1–M8)', () => {
  const source = fs.readFileSync('scripts/mac_app.swift', 'utf8');

  it('measures an outage with suspend-aware monotonic time, not wall-clock sleep time', () => {
    expect(source).toContain('private var unresponsiveSince: DispatchTime?');
    expect(source).toContain('DispatchTime.now().uptimeNanoseconds');
    expect(source).not.toContain('now.timeIntervalSince(unresponsiveSince!');
  });

  it('M1 & M2: routes external http/https links and popups to NSWorkspace and sanitizes WKDownload filenames', () => {
    expect(source).toContain('createWebViewWith configuration: WKWebViewConfiguration');
    expect(source).toContain('decidePolicyFor navigationAction: WKNavigationAction');
    expect(source).toContain('action == "open-external"');
    expect(source).toContain('static func sanitizeDownloadFilename(_ raw: String) -> String');
    expect(source).toContain('static func uniqueDownloadDestination(in directory: URL, suggestedFilename: String) -> URL');
    expect(source).toContain('didFailWithError error: Error');
    expect(source).toContain('ProcessInfo.processInfo.environment["AIRBRIDGE_DEV_EXTRAS"] == "1"');
  });

  it('M3, M4, M5 & M7: starts in .accessory when launchedInBackground, scrubs copyDiagnostics with macApp block, and hardens supervisor/BLE/SSE', () => {
    expect(source).toContain('app.setActivationPolicy(delegate.launchedInBackground ? .accessory : .regular)');
    expect(source).toContain('NSApp.setActivationPolicy(.regular)');
    expect(source).toContain('static func scrubDiagnosticsText(_ input: String) -> String');
    expect(source).toContain('"bundleId":');
    expect(source).toContain('"notificationAuthStatus":');
    expect(source).toContain('"bleState":');
    expect(source).toContain('"sseConnected":');
    expect(source).toContain('"webViewLoaded":');
    expect(source).toContain('"launchAgentPresent":');
    expect(source).toContain('"supervisorEarlyExits":');
    expect(source).toContain('config.connectionProxyDictionary = [:]');
    expect(source).toContain('private let logLock = NSLock()');
    expect(source).toContain('dataLines.joined(separator: "\\n")');
    expect(source).toContain('envelope.count + v.count <= 512');
    expect(source).toContain('peripheralManagerIsReady(toUpdateSubscribers');
    expect(source).toContain('button.setAccessibilityLabel("AirBridge")');
  });

  it('M8: test-mac-app.sh and daemon plist include Sequoia local network keys and launchd supervision', () => {
    const testScript = fs.readFileSync('scripts/test-mac-app.sh', 'utf8');
    const plist = fs.readFileSync('macos/com.airbridge.daemon.plist', 'utf8');
    expect(testScript).toContain('NSLocalNetworkUsageDescription');
    expect(testScript).toContain('NSBonjourServices');
    expect(plist).toContain('AIRBRIDGE_SUPERVISED');
    expect(plist).toContain('SuccessfulExit');
  });
});
