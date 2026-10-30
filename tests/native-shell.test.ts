// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AirBridgeNativeBridge,
  forgetNativeComputer,
  installNativeShellBridge,
  isNativeShell,
  saveBlobToDevice,
  scanPairingCode,
  toBase64,
} from "../src/client/engine/nativeShell.js";
import {
  triggerBatchZipDownload,
  triggerSingleFileDownload,
} from "../src/client/engine/fileDropUtils.js";
import type { ReceivedFileRecord } from "../src/client/engine/warpClient.js";

class FakeBridge implements AirBridgeNativeBridge {
  clipped = "";
  saved: Array<{ name: string; mimeType: string; chunks: Uint8Array[] }> = [];
  aborted: number[] = [];
  failAppendAfter = Number.POSITIVE_INFINITY;
  scanQr: () => boolean = () => true;
  forgetComputer: () => boolean = () => true;
  private open = new Map<number, { name: string; mimeType: string; chunks: Uint8Array[] }>();
  private nextHandle = 1;

  copyText(text: string): boolean {
    this.clipped = text;
    return true;
  }

  readClipboard(): string {
    return this.clipped;
  }

  beginSave(name: string, mimeType: string): number {
    const handle = this.nextHandle++;
    this.open.set(handle, { name, mimeType, chunks: [] });
    return handle;
  }

  appendSave(handle: number, base64Chunk: string): boolean {
    const entry = this.open.get(handle);
    if (!entry) return false;
    if (entry.chunks.length >= this.failAppendAfter) return false;
    entry.chunks.push(Uint8Array.from(atob(base64Chunk), (c) => c.charCodeAt(0)));
    return true;
  }

  finishSave(handle: number): string {
    const entry = this.open.get(handle);
    if (!entry) return "";
    this.open.delete(handle);
    this.saved.push(entry);
    return `/storage/emulated/0/Download/${entry.name}`;
  }

  abortSave(handle: number): void {
    this.open.delete(handle);
    this.aborted.push(handle);
  }
}

function receivedRecord(name: string, bytes: number[], mimeType = "text/plain"): ReceivedFileRecord {
  return {
    index: 0,
    name,
    size: bytes.length,
    mimeType,
    chunks: [Uint8Array.from(bytes)],
    sha256: "",
    verified: true,
  };
}

const clickedHrefs: string[] = [];
const originalCreateElement = document.createElement.bind(document);

beforeEach(() => {
  clickedHrefs.length = 0;
  document.createElement = ((tag: string) => {
    const element = originalCreateElement(tag);
    if (tag === "a") {
      (element as HTMLAnchorElement).click = () => {
        clickedHrefs.push((element as HTMLAnchorElement).download);
      };
    }
    return element;
  }) as typeof document.createElement;
  Object.defineProperty(URL, "createObjectURL", {
    value: () => "blob:airbridge-test",
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  document.createElement = originalCreateElement;
  delete (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid;
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

describe("native shell detection", () => {
  it("is inert in a plain browser", () => {
    expect(isNativeShell()).toBe(false);
    expect(installNativeShellBridge()).toBe(false);
    expect(scanPairingCode()).toBe(false);
    expect(forgetNativeComputer()).toBe(false);
  });

  it("drives the shell-only actions through the bridge", () => {
    const bridge = new FakeBridge();
    const scanQr = vi.fn(() => true);
    const forgetComputer = vi.fn(() => true);
    bridge.scanQr = scanQr;
    bridge.forgetComputer = forgetComputer;
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = bridge;

    expect(scanPairingCode()).toBe(true);
    expect(forgetNativeComputer()).toBe(true);
    expect(scanQr).toHaveBeenCalledTimes(1);
    expect(forgetComputer).toHaveBeenCalledTimes(1);
  });

  it("reports a camera-less phone as unable to scan", () => {
    const bridge = new FakeBridge();
    bridge.scanQr = () => false;
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = bridge;
    expect(scanPairingCode()).toBe(false);
  });

  it("activates when the Android bridge is present", () => {
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = new FakeBridge();
    expect(isNativeShell()).toBe(true);
    expect(installNativeShellBridge()).toBe(true);
  });
});

describe("saveBlobToDevice", () => {
  it("streams the blob through the bridge in order", async () => {
    const bridge = new FakeBridge();
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = bridge;
    const bytes = new Uint8Array(600 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

    const ok = await saveBlobToDevice(new Blob([bytes], { type: "application/octet-stream" }), "clip.bin");

    expect(ok).toBe(true);
    expect(bridge.saved).toHaveLength(1);
    const entry = bridge.saved[0];
    expect(entry.name).toBe("clip.bin");
    expect(entry.mimeType).toBe("application/octet-stream");
    // 600 KiB is delivered as three 256 KiB chunks.
    expect(entry.chunks.map((chunk) => chunk.length)).toEqual([262144, 262144, 90112]);
    const joined = new Uint8Array(entry.chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of entry.chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    expect(Array.from(joined)).toEqual(Array.from(bytes));
  });

  it("aborts the native download when a chunk write fails", async () => {
    const bridge = new FakeBridge();
    bridge.failAppendAfter = 1;
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = bridge;

    const ok = await saveBlobToDevice(new Blob([new Uint8Array(600 * 1024)]), "clip.bin");

    expect(ok).toBe(false);
    expect(bridge.aborted).toHaveLength(1);
    expect(bridge.saved).toHaveLength(0);
  });

  it("reports failure without a bridge so callers can fall back", async () => {
    expect(await saveBlobToDevice(new Blob(["hi"]), "note.txt")).toBe(false);
  });

  it("encodes bytes as standard base64", () => {
    expect(toBase64(Uint8Array.from([0, 1, 2, 250, 251, 252]))).toBe(
      btoa(String.fromCharCode(0, 1, 2, 250, 251, 252)),
    );
  });
});

describe("received file downloads", () => {
  it("uses the native writer inside the Android shell", async () => {
    const bridge = new FakeBridge();
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = bridge;

    triggerSingleFileDownload(receivedRecord("photo.txt", [1, 2, 3]));
    await vi.waitFor(() => expect(bridge.saved).toHaveLength(1));

    expect(bridge.saved[0].name).toBe("photo.txt");
    expect(Array.from(bridge.saved[0].chunks[0])).toEqual([1, 2, 3]);
    expect(clickedHrefs).toEqual([]);
  });

  it("saves a multi-file transfer as a zip through the native writer", async () => {
    const bridge = new FakeBridge();
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = bridge;

    triggerBatchZipDownload([receivedRecord("a.txt", [1]), receivedRecord("b.txt", [2, 3])]);
    await vi.waitFor(() => expect(bridge.saved).toHaveLength(1));

    expect(bridge.saved[0].name).toBe("AirBridge-Bundle.zip");
    expect(bridge.saved[0].mimeType).toBe("application/zip");
    // "PK\x03\x04" — a real zip header, not a placeholder.
    expect(Array.from(bridge.saved[0].chunks[0].slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("keeps the browser download in a plain browser", () => {
    triggerSingleFileDownload(receivedRecord("photo.txt", [1, 2, 3]));
    expect(clickedHrefs).toEqual(["photo.txt"]);
  });
});

describe("clipboard bridge", () => {
  it("writes and reads through the native clipboard", async () => {
    const bridge = new FakeBridge();
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = bridge;
    installNativeShellBridge();

    await navigator.clipboard.writeText("hello from the shell");
    expect(bridge.clipped).toBe("hello from the shell");
    await expect(navigator.clipboard.readText()).resolves.toBe("hello from the shell");
  });

  it("falls back to the browser clipboard when the native write fails", async () => {
    const bridge = new FakeBridge();
    bridge.copyText = () => false;
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = bridge;
    const fallback = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText: fallback }, configurable: true });

    installNativeShellBridge();
    await navigator.clipboard.writeText("falls back");

    expect(fallback).toHaveBeenCalledWith("falls back");
  });

  it("reports clipboard permission as granted so auto-beam keeps working", async () => {
    const denied = vi.fn(async () => ({ state: "denied" }) as PermissionStatus);
    Object.defineProperty(navigator, "permissions", {
      value: { query: denied },
      configurable: true,
    });
    (window as { AirBridgeAndroid?: unknown }).AirBridgeAndroid = new FakeBridge();
    installNativeShellBridge();

    const status = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
    expect(status.state).toBe("granted");
    // Other permission names are untouched.
    const geolocation = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    expect(geolocation.state).toBe("denied");
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
