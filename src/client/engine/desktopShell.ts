/**
 * Bridge to the native macOS app shell (scripts/mac_app.swift), which hosts
 * this page in a WKWebView and supervises the local AirBridge service.
 */
import { isLoopbackHostname } from './pairingUrl.js';

interface WebKitBridge {
  messageHandlers?: { airbridgeShell?: { postMessage: (message: unknown) => void } };
}

function shellBridge(): { postMessage: (message: unknown) => void } | null {
  if (typeof window === 'undefined') return null;
  const webkit = (window as unknown as { webkit?: WebKitBridge }).webkit;
  return webkit?.messageHandlers?.airbridgeShell ?? null;
}

/** The page is served by the AirBridge service on this same computer. */
export function isThisComputerPage(): boolean {
  if (typeof window === 'undefined') return false;
  return isLoopbackHostname(window.location.hostname);
}

/** The macOS app can (re)start the service on request. */
export function canRestartLocalService(): boolean {
  return shellBridge() !== null;
}

/** Ask the macOS app to restart the local service; it reloads this page when ready. */
export function requestLocalServiceRestart(): boolean {
  const bridge = shellBridge();
  if (!bridge) return false;
  try {
    bridge.postMessage({ action: 'restart-server' });
    return true;
  } catch {
    return false;
  }
}

/** Copy through AppKit when WKWebView's browser clipboard APIs are unavailable. */
export function copyTextToDesktopShell(text: string): boolean {
  if (!isThisComputerPage() || text.length > 1_000_000) return false;
  const bridge = shellBridge();
  if (!bridge) return false;
  try {
    bridge.postMessage({ action: 'copy-text', text });
    return true;
  } catch {
    return false;
  }
}

/** Ask the macOS app shell to open an external http(s) URL in the default browser. */
export function openExternalInDesktopShell(url: string): boolean {
  if (!isThisComputerPage()) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  } catch {
    return false;
  }
  const bridge = shellBridge();
  if (!bridge) return false;
  try {
    bridge.postMessage({ action: 'open-external', url });
    return true;
  } catch {
    return false;
  }
}
