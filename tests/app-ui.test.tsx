// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { webcrypto } from "node:crypto";
import { bytesToBase64Url, type ControlPayload } from "../src/shared/protocol.js";
import { decryptControlPayload, derivePeerSession, encryptControlPayload } from "../src/client/engine/crypto.js";

// Tell React its act() helpers are available in this jsdom test file.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not wire Node's WebCrypto or a secure context by default.
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}
Object.defineProperty(window, "isSecureContext", {
  value: true,
  configurable: true,
});

interface SentMessage {
  type: string;
  [key: string]: unknown;
}

// Real P-256 public key for the fake peer, regenerated per test so the
// client's ECDH importKey / deriveBits actually succeeds.
let peerPublicKeyB64 = "";
let peerPrivateKey: CryptoKey | null = null;

async function pushEncrypted(socket: FakeSocket, payload: ControlPayload) {
  const hello = socket.sentMessages.find((m) => m.type === "hello") as unknown as { device: { publicKey: string } };
  const session = await derivePeerSession(peerPrivateKey!, peerPublicKeyB64, hello.device.publicKey);
  const envelope = await encryptControlPayload(session.aesKey, payload);
  socket.pushServerMessage({ type: "transfer-control", from: "1122334455667788", envelope });
}

// ---- Minimal in-page fake WebSocket + signaling server --------------------
class FakeSocket {
  static instances: FakeSocket[] = [];
  static lastInstance: FakeSocket | null = null;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 1;
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sentMessages: SentMessage[] = [];
  sentBinaryCount = 0;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
    FakeSocket.lastInstance = this;
    setTimeout(() => this.onopen?.(new Event("open")), 0);
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob) {
    if (typeof data !== "string") {
      this.sentBinaryCount++;
      return;
    }
    const msg = JSON.parse(data) as SentMessage;
    this.sentMessages.push(msg);
    if (msg.type === "hello") {
      setTimeout(() => {
        this.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "welcome",
              peerId: "aabbccddeeff0011",
              pairCode: "ABC123",
              serverVersion: "0.0.5",
              lanUrls: ["http://localhost:3000"],
              localDaemon: {
                enabled: false,
                platform: "unknown",
                hostname: "",
                autoSaveToDownloads: false,
              },
              peers: [
                {
                  peerId: "1122334455667788",
                  device: {
                    name: "Pixel Phone",
                    platform: "android",
                    model: "Pixel",
                    formFactor: "phone",
                    publicKey: peerPublicKeyB64,
                  },
                  discoveryScope: "paired",
                  connectedAt: Date.now(),
                },
              ],
            }),
          }),
        );
      }, 0);
    }
  }

  pushServerMessage(message: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  close() {
    this.readyState = 3;
  }
  addEventListener() {}
  removeEventListener() {}
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    if (predicate()) return;
  }
  throw new Error("waitFor timed out");
}

const roots: ReturnType<typeof createRoot>[] = [];

async function renderApp() {
  const { App } = await import("../src/client/App.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(App));
  });
  // Wait until the (fake) welcome round-trip renders the discovered peer.
  await waitFor(() => container.querySelector(".device-row") !== null);
  return { container, root };
}

function findButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(label),
  );
  if (!match) throw new Error(`button "${label}" not found`);
  return match;
}

function setNativeValue(
  element: HTMLTextAreaElement | HTMLSelectElement,
  constructor: { prototype: object },
  value: string,
  eventName: string,
) {
  const descriptor = Object.getOwnPropertyDescriptor(
    constructor.prototype,
    "value",
  );
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
}

describe("AirBridge app UI", () => {
  beforeEach(async () => {
    try { window.localStorage?.clear(); } catch (_e) { /* ignore */ }
    try { localStorage?.clear(); } catch (_e) { /* ignore */ }
    FakeSocket.instances = [];
    FakeSocket.lastInstance = null;
    const peerKeys = await webcrypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const rawPeerPub = new Uint8Array(
      await webcrypto.subtle.exportKey("raw", peerKeys.publicKey),
    );
    peerPublicKeyB64 = bytesToBase64Url(rawPeerPub);
    peerPrivateKey = peerKeys.privateKey;
    // @ts-expect-error fake socket
    globalThis.WebSocket = FakeSocket;
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {},
          readText: async () => "",
        },
        configurable: true,
      });
    }
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    while (roots.length) {
      const root = roots.pop();
      root?.unmount();
    }
  });

  it("stages a picked file and enables Send even when the browser clears the live FileList", async () => {
    // Regression: the input resets value="" in its change handler. Real
    // browsers empty the SAME live FileList object, so a deferred React state
    // updater used to stage zero files and Send stayed disabled.
    const { container } = await renderApp();

    const sendButton = findButton(container, "Send") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["hello world contents"], "notes.txt", {
      type: "text/plain",
    });

    // Browser-faithful FileList: cleared in place when input.value is reset.
    const fileList: { length: number; item: (i: number) => File | null } & Record<
      number,
      File
    > = {
      0: file,
      length: 1,
      item: (i: number) => (i === 0 ? file : null),
    };
    Object.defineProperty(input, "files", {
      get: () => fileList,
      configurable: true,
    });
    let inputValue = "";
    Object.defineProperty(input, "value", {
      get: () => inputValue,
      set: (next: string) => {
        inputValue = next;
        if (next === "") {
          delete (fileList as Record<number, File>)[0];
          fileList.length = 0;
          fileList.item = () => null;
        }
      },
      configurable: true,
    });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });

    const staged = container.querySelectorAll(".staged-list li");
    expect(staged.length).toBe(1);
    expect(staged[0].textContent).toContain("notes.txt");
    expect(sendButton.disabled).toBe(false);
  });

  it("shows a live Upload speed in the main active-transfer row", async () => {
    const { container } = await renderApp();
    const socket = FakeSocket.lastInstance!;
    const raw = new Uint8Array(4 * 1024 * 1024).fill(23);
    const file = new File([raw], "speed.bin", { type: "application/octet-stream" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const fileList: { length: number; item: (i: number) => File | null } & Record<number, File> = {
      0: file,
      length: 1,
      item: (i) => i === 0 ? file : null,
    };
    Object.defineProperty(input, "files", { get: () => fileList, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      (container.querySelector(".send-device-button") as HTMLButtonElement).click();
    });

    await waitFor(() => socket.sentMessages.some((message) => message.type === "transfer-control"));
    const hello = socket.sentMessages.find((message) => message.type === "hello") as unknown as {
      device: { publicKey: string };
    };
    const peerSession = await derivePeerSession(
      peerPrivateKey!,
      peerPublicKeyB64,
      hello.device.publicKey,
    );
    let transferId = "";
    for (const message of socket.sentMessages.filter((item) => item.type === "transfer-control").reverse()) {
      const envelope = message.envelope as Parameters<typeof decryptControlPayload>[1] | undefined;
      if (!envelope?.encrypted) continue;
      const payload = await decryptControlPayload(peerSession.aesKey, envelope);
      if (payload.kind === "transfer-offer") {
        transferId = payload.transferId;
        break;
      }
    }
    expect(transferId).not.toBe("");

    await act(async () => {
      await pushEncrypted(socket, {
        kind: "transfer-accept",
        transferId,
        preferredTransport: "ws-relay",
      });
    });
    await waitFor(() => socket.sentBinaryCount >= 4);
    expect(container.querySelector(".transfer-row")?.textContent).toContain("0 B of 4.00 MB");
    await act(async () => {
      await pushEncrypted(socket, {
        kind: "chunk-ack",
        transferId,
        fileIndex: 0,
        ackedChunkIndex: 1,
        bytesReceivedTotal: 2 * 1024 * 1024,
      });
    });
    await waitFor(() => {
      const row = container.querySelector(".transfer-row");
      return Boolean(row?.textContent?.includes("Upload") && row.textContent.includes("/s"));
    });
    expect(container.querySelector(".transfer-row")?.textContent).toMatch(/Upload .*\/s/);
  });

  it("beams clipboard text to a peer through the encrypted control channel", async () => {
    const { container } = await renderApp();

    await act(async () => {
      findButton(container, "Clipboard").click();
    });

    const textarea = container.querySelector(
      ".clipboard-compose textarea",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    const select = container.querySelector(
      ".clipboard-destination select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("1122334455667788");

    const beamButton = findButton(container, "Beam text") as HTMLButtonElement;
    expect(beamButton.disabled).toBe(true);

    await act(async () => {
      setNativeValue(textarea, HTMLTextAreaElement, "849201", "input");
    });
    expect(beamButton.disabled).toBe(false);

    await act(async () => {
      beamButton.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    const controlFrames = FakeSocket.instances.flatMap((s) =>
      s.sentMessages.filter((m) => m.type === "transfer-control"),
    );
    expect(controlFrames.length).toBeGreaterThan(0);
    const envelope = controlFrames[controlFrames.length - 1] as unknown as {
      envelope: { encrypted: boolean };
    };
    expect(envelope.envelope.encrypted).toBe(true);

    const historyItems = container.querySelectorAll(".clipboard-item");
    expect(historyItems.length).toBe(1);
    expect(historyItems[0].textContent).toContain("849201");
  });

  it("shows an incoming clipboard beam in history with a Copy toast action", async () => {
    const { container } = await renderApp();
    const socket = FakeSocket.lastInstance!;

    await act(async () => {
      await pushEncrypted(socket, {
        kind: "clipboard-beam",
        beamId: "beam-001",
        text: "https://example.com/login?t=abc",
        contentType: "url",
        timestamp: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 30));
    });

    const toast = container.querySelector(".utility-toast");
    expect(toast?.textContent).toContain("Clipboard from Pixel Phone");
    const copyAction = toast?.querySelector(
      ".toast-action",
    ) as HTMLButtonElement;
    expect(copyAction?.textContent).toBe("Copy");

    await act(async () => {
      findButton(container, "Clipboard").click();
    });
    const historyItem = container.querySelector(".clipboard-item");
    expect(historyItem?.textContent).toContain(
      "https://example.com/login?t=abc",
    );
    expect(historyItem?.querySelector("a")?.textContent).toContain("Open URL");
  });

  it("auto-beams copied text on copy event and on background host-clipboard events without opening the Clipboard modal", async () => {
    const { container } = await renderApp();
    const socket = FakeSocket.lastInstance!;

    // 1. Simulate pressing Cmd+C / Ctrl+C on the page without opening Clipboard modal
    await act(async () => {
      const copyEvent = new Event("copy", { bubbles: true }) as Event & {
        clipboardData: { getData: (type: string) => string };
      };
      copyEvent.clipboardData = {
        getData: (type: string) =>
          type === "text/plain" ? "copied-inline-snippet" : "",
      };
      document.dispatchEvent(copyEvent);
      await new Promise((r) => setTimeout(r, 40));
    });

    let controlFrames = FakeSocket.instances.flatMap((s) =>
      s.sentMessages.filter((m) => m.type === "transfer-control"),
    );
    expect(controlFrames.length).toBeGreaterThan(0);
    expect(container.querySelector(".utility-toast")?.textContent).toContain(
      "Clipboard beamed to Pixel Phone",
    );

    // 2. Simulate background OS clipboard push from server (user copied in another app)
    const countBeforeHostPush = controlFrames.length;
    await act(async () => {
      socket.pushServerMessage({
        type: "host-clipboard",
        text: "copied-in-external-app-9912",
        timestamp: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 40));
    });

    controlFrames = FakeSocket.instances.flatMap((s) =>
      s.sentMessages.filter((m) => m.type === "transfer-control"),
    );
    expect(controlFrames.length).toBeGreaterThan(countBeforeHostPush);

    // Verify both auto-beamed items are recorded in Clipboard history
    await act(async () => {
      findButton(container, "Clipboard").click();
    });
    const historyTexts = Array.from(
      container.querySelectorAll(".clipboard-item pre"),
    ).map((el) => el.textContent);
    expect(historyTexts).toContain("copied-in-external-app-9912");
    expect(historyTexts).toContain("copied-inline-snippet");
  });

  it("shows the received-files folder in Settings, saves a new path, and locates it with the folder icon", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const originalFetch = globalThis.fetch;
    // @ts-expect-error test fetch stub
    globalThis.fetch = async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      if (String(url) === "/api/received-folder" && !init?.method) {
        return { ok: true, json: async () => ({ downloadDir: "/Users/test/Downloads/AirBridge", enabled: true, autoSaveToDownloads: true }) };
      }
      if (String(url) === "/api/received-folder" && init?.method === "PUT") {
        return { ok: true, json: async () => ({ downloadDir: "/Users/test/Pictures/Received", enabled: true, autoSaveToDownloads: true }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };
    try {
      const { container } = await renderApp();
      // Header locate icon appears once the folder is known.
      await waitFor(() => container.querySelector('button[aria-label="Open received files folder"]') !== null);
      await act(async () => { findButton(container, "Settings").click(); });
      const input = container.querySelector('input[aria-label="Received files folder path"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(container.textContent).toContain("/Users/test/Downloads/AirBridge");
      await act(async () => { setNativeValue(input as unknown as HTMLTextAreaElement, HTMLInputElement as unknown as { prototype: object }, "/Users/test/Pictures/Received", "input"); });
      const saveBtn = findButton(container, "Save folder") as HTMLButtonElement;
      await act(async () => { saveBtn.click(); await new Promise((r) => setTimeout(r, 30)); });
      expect(calls.some((c) => c.url === "/api/received-folder" && c.method === "PUT" && String(c.body).includes("Pictures/Received"))).toBe(true);
      expect(container.textContent).toContain("/Users/test/Pictures/Received");
      // Folder icon inside Settings opens the folder through the client.
      const icon = container.querySelector('.received-folder-setting button[aria-label="Open received files folder"]') as HTMLButtonElement;
      await act(async () => { icon.click(); await new Promise((r) => setTimeout(r, 20)); });
      expect(calls.some((c) => c.url === "/api/received-folder/open" && c.method === "POST")).toBe(true);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("displays Recent transfers newest-first on Android with header count and Save button for received files", async () => {
    const { container } = await renderApp();
    const socket = FakeSocket.lastInstance!;

    // 1. Reconcile two historical transfers from MacBook via history-sync (intentionally sent oldest-first)
    await act(async () => {
      await pushEncrypted(socket, {
            kind: "history-sync",
            transfers: [
              {
                transferId: "hist-older",
                peerName: "MacBook Pro",
                peerPlatform: "macos",
                direction: "outgoing",
                status: "completed",
                transport: "webrtc",
                files: [
                  {
                    index: 0,
                    name: "older-notes.txt",
                    size: 1024,
                    mimeType: "text/plain",
                    totalChunks: 1,
                    chunkSize: 65536,
                  },
                ],
                totalBytes: 1024,
                transferredBytes: 1024,
                startedAt: 1_700_000_000_000,
                completedAt: 1_700_000_001_000,
                sasCode: "123 456",
              },
              {
                transferId: "hist-newer",
                peerName: "MacBook Pro",
                peerPlatform: "macos",
                direction: "outgoing",
                status: "completed",
                transport: "webrtc",
                files: [
                  {
                    index: 0,
                    name: "newest-invoice.pdf",
                    size: 20480,
                    mimeType: "application/pdf",
                    totalChunks: 1,
                    chunkSize: 65536,
                  },
                ],
                totalBytes: 20480,
                transferredBytes: 20480,
                startedAt: 1_700_000_050_000,
                completedAt: 1_700_000_055_000,
                sasCode: "123 456",
              },
            ],
      });
      await new Promise((r) => setTimeout(r, 30));
    });

    // Header badge reflects count
    const recentBtn = findButton(container, "Recent");
    expect(recentBtn.textContent).toContain("Recent (2)");

    await act(async () => {
      recentBtn.click();
    });

    const rows = Array.from(container.querySelectorAll(".recent-row"));
    expect(rows).toHaveLength(2);
    // Newest transfer MUST appear at the top (index 0), not reversed to the bottom
    expect(rows[0].textContent).toContain("newest-invoice.pdf");
    expect(rows[0].textContent).toContain("Received");
    expect(rows[1].textContent).toContain("older-notes.txt");
  });

  it("shows the app version and Contacts / Calls / Screen in the top bar, with live call controls", async () => {
    const { container } = await renderApp();
    const header = container.querySelector(".utility-header")!;
    // Version like any desktop app (UI bundle version, falling back to the service's).
    expect(header.querySelector(".version-badge")?.textContent).toBe("v0.0.5");
    for (const label of ["Contacts", "Calls", "Screen"]) {
      expect(Array.from(header.querySelectorAll("button")).some((b) => b.textContent?.includes(label))).toBe(true);
    }

    // Before the phone announces features, the panel explains what to do.
    await act(async () => { findButton(container, "Calls").click(); });
    expect(container.querySelector(".continuity-modal h2")?.textContent).toBe("Calls");
    expect(container.querySelector(".continuity-guidance")?.textContent).toContain("hasn't announced phone features");

    const socket = FakeSocket.lastInstance!;
    await act(async () => {
      await pushEncrypted(socket, { kind: "continuity-hello", v: 1, features: ["contacts.receive", "contacts.provide", "calls.control", "screen.source"] });
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => container.querySelector(".dialer") !== null);
    expect(container.querySelector('[aria-label="Keypad"]')?.querySelectorAll("button").length).toBe(12);

    // A ringing call shows an always-visible banner and a header badge.
    await act(async () => {
      await pushEncrypted(socket, {
        kind: "call-state",
        call: { callId: "0123456789abcdef", state: "ringing", direction: "incoming", number: "+1 555 0100", name: "Ada Lovelace", updatedAt: Date.now(), actions: ["answer", "reject"] },
      });
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => container.querySelector(".incoming-call") !== null);
    const banner = container.querySelector(".incoming-call")!;
    expect(banner.textContent).toContain("Ada Lovelace");
    expect(banner.textContent).toContain("Incoming call on Pixel Phone");
    expect(header.querySelector('[aria-label="Calls (1 active)"]')).not.toBeNull();
    const before = socket.sentMessages.filter((m) => m.type === "transfer-control").length;
    await act(async () => {
      Array.from(banner.querySelectorAll("button")).find((b) => b.textContent === "Answer")!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    // The answer command left encrypted over the session.
    await waitFor(() => socket.sentMessages.filter((m) => m.type === "transfer-control").length > before);

    // Escape closes the panel.
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(container.querySelector(".continuity-modal")).toBeNull();
  });

  it("opens panels requested by the desktop shells (macOS menu bar, Linux launcher ?panel=)", async () => {
    // Linux launcher action: AirBridge --open contacts → /?panel=contacts&pair=…
    window.history.replaceState(null, "", "/?panel=contacts&keep=1#top");
    // macOS: a menu click that raced the page load is parked for the app.
    window.__airbridgePendingPanel = "screen";
    try {
      const { container } = await renderApp();
      await waitFor(() => container.querySelector(".continuity-modal") !== null);
      // ?panel= is consumed (a reload must not reopen it); other params survive.
      expect(window.location.search).toBe("?keep=1");
      expect(window.location.hash).toBe("#top");
      expect(window.__airbridgePendingPanel).toBeUndefined();
      expect(container.querySelector(".continuity-modal h2")?.textContent).toBe("Contacts");

      // The macOS menu bar calls the page directly once it has loaded.
      expect(typeof window.__airbridgeOpenPanel).toBe("function");
      await act(async () => { expect(window.__airbridgeOpenPanel!("calls")).toBe(true); });
      expect(container.querySelector(".continuity-modal h2")?.textContent).toBe("Calls");
      await act(async () => { window.__airbridgeOpenPanel!("screen"); });
      expect(container.querySelector(".continuity-modal h2")?.textContent).toBe("Screen");

      // Unknown names are refused without side effects; Settings opens Preferences.
      await act(async () => { expect(window.__airbridgeOpenPanel!("javascript:alert(1)")).toBe(false); });
      expect(container.querySelector(".continuity-modal h2")?.textContent).toBe("Screen");
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      await act(async () => { expect(window.__airbridgeOpenPanel!("settings")).toBe(true); });
      expect(container.querySelector("#settings-title")?.textContent).toBe("Settings");
    } finally {
      window.history.replaceState(null, "", "/");
      delete window.__airbridgePendingPanel;
    }
  });
});
