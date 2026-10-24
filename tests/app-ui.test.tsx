// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { webcrypto } from "node:crypto";
import { bytesToBase64Url } from "../src/shared/protocol.js";

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
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
    FakeSocket.lastInstance = this;
    setTimeout(() => this.onopen?.(new Event("open")), 0);
  }

  send(data: string) {
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
                  discoveryScope: "nearby",
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
    localStorage.clear();
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
      socket.pushServerMessage({
        type: "transfer-control",
        from: "1122334455667788",
        envelope: {
          encrypted: false,
          payload: {
            kind: "clipboard-beam",
            beamId: "beam-001",
            text: "https://example.com/login?t=abc",
            contentType: "url",
            timestamp: Date.now(),
          },
        },
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

  it("displays Recent transfers newest-first on Android with header count and Save button for received files", async () => {
    const { container } = await renderApp();
    const socket = FakeSocket.lastInstance!;

    // 1. Reconcile two historical transfers from MacBook via history-sync (intentionally sent oldest-first)
    await act(async () => {
      socket.pushServerMessage({
        type: "transfer-control",
        from: "1122334455667788",
        envelope: {
          encrypted: false,
          payload: {
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
          },
        },
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
});
