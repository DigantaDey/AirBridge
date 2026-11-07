/**
 * Native Android shell integration.
 *
 * The Android app is a thin shell around this exact web UI: it renders the
 * page served by the desktop AirBridge server (tunnelled over loopback, so the
 * page is a secure context) and exposes a small Javascript interface. Two
 * browser APIs that the web UI depends on are either missing or blocked inside
 * a WebView:
 *
 *   - `navigator.clipboard` needs a focused document plus a permission prompt
 *     that WebView never shows, so copy/paste silently fails;
 *   - `<a download>` of a `blob:` URL does nothing, so received files could
 *     never be saved.
 *
 * Both are routed through `window.AirBridgeAndroid` when it exists (see
 * `android/app/src/main/kotlin/com/airbridge/app/ShellBridge.kt`). In a normal
 * browser every function here is a no-op and the original behaviour is kept
 * byte for byte, which is what the rest of the app relies on.
 */

/** Chunk size handed to the native writer — big enough to be fast, small enough to stay off the JS heap. */
const SAVE_CHUNK_BYTES = 256 * 1024;

/** The interface Android injects with `addJavascriptInterface`. */
export interface AirBridgeNativeBridge {
  /** Writes text to the device clipboard. Returns false when it could not. */
  copyText(text: string): boolean;
  /** Reads the device clipboard ('' when empty or unavailable). */
  readClipboard(): string;
  /** Opens a new download; returns a handle, or -1 when it could not start. */
  beginSave(name: string, mimeType: string): number;
  /** Appends one base64 chunk; returns false when the write failed. */
  appendSave(handle: number, base64Chunk: string): boolean;
  /** Finalises the download; returns the saved location ('' on failure). */
  finishSave(handle: number): string;
  /** Discards a partially written download. */
  abortSave(handle: number): void;
  /** Opens the phone's QR scanner (returns false when there is no camera). */
  scanQr?(): boolean;
  /** Unpairs and returns to the connect screen. */
  forgetComputer?(): boolean;
  connectionContinuityEnabled?(): boolean;
  setConnectionContinuityEnabled?(enabled: boolean): boolean;
  /** Explicit, persisted opt-in for Accessibility-assisted hidden clipboard capture. */
  accessibilityOptInEnabled?(): boolean;
  setAccessibilityOptInEnabled?(enabled: boolean): boolean;
  /** Whether the user has enabled the AirBridge service in Android Settings. */
  accessibilityServiceEnabled?(): boolean;
  /** Opens Android's Accessibility settings; cannot enable the service itself. */
  openAccessibilitySettings?(): boolean;
  /** Holds a native foreground service / partial wake lock only while a transfer is active. */
  setTransferActive?(active: boolean): boolean;
  /** Updates the foreground notification with the live Upload/Download rate. */
  updateTransferSpeed?(payloadJson: string): boolean;
  /** Keeps the Android status/navigation bars legible in light or dark mode. */
  setDarkTheme?(enabled: boolean): boolean;
}

/** Minimal live-transfer shape the Android notification needs. */
export interface NativeTransferSpeedSnapshot {
  direction: "incoming" | "outgoing";
  status?: string;
  speedBytesPerSec?: number;
  transferredBytes?: number;
  totalBytes?: number;
  etaSeconds?: number | null;
}

declare global {
  interface Window {
    AirBridgeAndroid?: AirBridgeNativeBridge;
    /** The Android foreground service pushes system-clipboard changes here. */
    __airbridgeNativeClipboard?: (text: string) => void;
    /** Android reports whether the Accessibility Service is enabled in OS settings. */
    __airbridgeNativeAccessibilityState?: (enabled: boolean) => void;
  }
}

function nativeBridge(): AirBridgeNativeBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = window.AirBridgeAndroid;
  if (
    candidate &&
    typeof candidate.copyText === "function" &&
    typeof candidate.beginSave === "function"
  ) {
    return candidate;
  }
  return undefined;
}

/** True when the UI runs inside the AirBridge Android app. */
export function isNativeShell(): boolean {
  return nativeBridge() !== undefined;
}

/**
 * Asks the shell to scan a pairing QR with the phone's camera. Only rendered on
 * the phone, and a no-op everywhere else, so the browser UI is unchanged.
 */
export function scanPairingCode(): boolean {
  const bridge = nativeBridge();
  if (!bridge || typeof bridge.scanQr !== "function") return false;
  try {
    return bridge.scanQr() !== false;
  } catch {
    return false;
  }
}

/** Ends the paired session and returns to the connect screen. */
export function forgetNativeComputer(): boolean {
  const bridge = nativeBridge();
  if (!bridge || typeof bridge.forgetComputer !== "function") return false;
  try {
    return bridge.forgetComputer() !== false;
  } catch {
    return false;
  }
}

export function getNativeConnectionContinuity(): boolean {
  try { return nativeBridge()?.connectionContinuityEnabled?.() === true; } catch { return false; }
}

export function setNativeConnectionContinuity(enabled: boolean): boolean {
  try { return nativeBridge()?.setConnectionContinuityEnabled?.(enabled) === true; } catch { return false; }
}

/** Off by default; the user must opt in and enable the OS service separately. */
export function getNativeAccessibilityOptIn(): boolean {
  try { return nativeBridge()?.accessibilityOptInEnabled?.() === true; } catch { return false; }
}

export function setNativeAccessibilityOptIn(enabled: boolean): boolean {
  try { return nativeBridge()?.setAccessibilityOptInEnabled?.(enabled) === true; } catch { return false; }
}

export function isNativeAccessibilityServiceEnabled(): boolean {
  try { return nativeBridge()?.accessibilityServiceEnabled?.() === true; } catch { return false; }
}

/** Opens Android Settings; the app cannot grant this permission itself. */
export function openNativeAccessibilitySettings(): boolean {
  try { return nativeBridge()?.openAccessibilitySettings?.() === true; } catch { return false; }
}

/** Sync Android's system bars with the web app's light/dark appearance. */
export function setNativeDarkTheme(enabled: boolean): boolean {
  try { return nativeBridge()?.setDarkTheme?.(enabled) === true; } catch { return false; }
}

/** Keep the Android CPU awake while the WebView is actively sending or receiving a transfer. */
export function setNativeTransferActive(active: boolean): boolean {
  try { return nativeBridge()?.setTransferActive?.(active) === true; } catch { return false; }
}

/**
 * Mirrors the in-page rate onto the Android foreground notification, so the
 * phone still shows Upload/Download speed while its screen is off. A null
 * snapshot clears the live rate when the transfer finishes or is cancelled.
 */
export function publishNativeTransferSpeed(
  snapshot: NativeTransferSpeedSnapshot | null,
): boolean {
  // A speed-only bridge is enough here; do not require the clipboard/save
  // methods that `nativeBridge()` uses to identify the full Android shell.
  const bridge = typeof window === "undefined" ? undefined : window.AirBridgeAndroid;
  if (!bridge || typeof bridge.updateTransferSpeed !== "function") return false;
  const active =
    snapshot !== null && (snapshot.status === undefined || snapshot.status === "transferring");
  const finite = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  const etaValue = snapshot?.etaSeconds;
  const eta =
    typeof etaValue === "number" && Number.isFinite(etaValue) && etaValue > 0
      ? Math.ceil(etaValue)
      : null;
  const payload = active && snapshot
    ? {
        active: true,
        direction: snapshot.direction === "incoming" ? "download" : "upload",
        speedBytesPerSec: finite(snapshot.speedBytesPerSec),
        transferredBytes: finite(snapshot.transferredBytes),
        totalBytes: finite(snapshot.totalBytes),
        etaSeconds: eta,
      }
    : { active: false };
  try {
    return bridge.updateTransferSpeed!(JSON.stringify(payload)) !== false;
  } catch {
    return false;
  }
}

/** base64 for a byte array without blowing the argument stack on large chunks. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

/**
 * Streams a blob into the device's Downloads folder through the native bridge.
 * Returns false when there is no bridge or the write failed, so callers can
 * fall back to the ordinary browser download.
 */
export async function saveBlobToDevice(blob: Blob, fileName: string): Promise<boolean> {
  const bridge = nativeBridge();
  if (!bridge) return false;
  let handle: number | null = null;
  try {
    handle = bridge.beginSave(fileName, blob.type || "application/octet-stream");
    if (typeof handle !== "number" || handle < 0) return false;
    for (let offset = 0; offset < blob.size; offset += SAVE_CHUNK_BYTES) {
      const slice = blob.slice(offset, Math.min(offset + SAVE_CHUNK_BYTES, blob.size));
      const bytes = new Uint8Array(await slice.arrayBuffer());
      if (!bridge.appendSave(handle, toBase64(bytes))) {
        throw new Error(`Native write failed for ${fileName}`);
      }
    }
    const saved = bridge.finishSave(handle);
    handle = null;
    return typeof saved === "string" && saved.length > 0;
  } catch {
    if (handle !== null) {
      try {
        bridge.abortSave(handle);
      } catch {
        // best effort
      }
    }
    return false;
  }
}

/**
 * Points `navigator.clipboard` at the native bridge. Called once from
 * `main.tsx`; returns true when the shell integration is active so callers can
 * log or branch on it.
 */
export function installNativeShellBridge(): boolean {
  const bridge = nativeBridge();
  if (!bridge) return false;

  const existing = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  const shim = {
    writeText: async (text: string): Promise<void> => {
      if (bridge.copyText(text)) return;
      if (existing?.writeText) {
        await existing.writeText(text);
        return;
      }
      throw new Error("Clipboard is not available");
    },
    readText: async (): Promise<string> => {
      const native = bridge.readClipboard();
      if (native) return native;
      if (existing?.readText) return existing.readText();
      return "";
    },
    write: existing?.write ? existing.write.bind(existing) : undefined,
    read: existing?.read ? existing.read.bind(existing) : undefined,
  } as unknown as Clipboard;

  try {
    Object.defineProperty(navigator, "clipboard", {
      value: shim,
      configurable: true,
      writable: false,
    });
  } catch {
    // Some WebView builds make the navigator instance non-extensible; the
    // original clipboard API then keeps its usual (failing) behaviour.
    return false;
  }

  // A WebView never shows the clipboard permission prompt, so report the
  // access the shell already has instead of letting auto-beam opt itself out.
  try {
    const permissions = navigator.permissions;
    if (permissions?.query) {
      const originalQuery = permissions.query.bind(permissions);
      permissions.query = ((descriptor: PermissionDescriptor) => {
        if (typeof descriptor?.name === "string" && descriptor.name.startsWith("clipboard")) {
          return Promise.resolve({ state: "granted" } as PermissionStatus);
        }
        return originalQuery(descriptor);
      }) as typeof permissions.query;
    }
  } catch {
    // Non-fatal: auto-beam falls back to its permission probe.
  }

  return true;
}
