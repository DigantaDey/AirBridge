// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64Url,
  encodeEncryptedChunkFrame,
  wrapRoutedRelayFrame,
  type ControlPayload,
} from "../src/shared/protocol.js";
import {
  derivePeerSession,
  encryptBinaryChunk,
  encryptControlPayload,
  sha256Hex,
} from "../src/client/engine/crypto.js";
import { ContinuityManager } from "../src/client/engine/continuity.js";
import {
  WarpClient,
  isSafeHttpUrl,
  type ClipboardBeamItem,
  type TransferSessionView,
} from "../src/client/engine/warpClient.js";
import { ClipboardCenter } from "../src/client/components/ClipboardCenter.js";
import { PairingDock } from "../src/client/components/PairingDock.js";
import {
  ServiceStatusBar,
  collectDiagnostics,
  recordClientDiagnosticError,
} from "../src/client/components/ServiceStatusBar.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static lastInstance: FakeWebSocket | null = null;
  static nextPeerPublicKeyB64 = "";
  static nextLocalDaemonEnabled = false;
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
  peerPublicKeyB64 = FakeWebSocket.nextPeerPublicKeyB64;
  localDaemonEnabled = FakeWebSocket.nextLocalDaemonEnabled;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    FakeWebSocket.lastInstance = this;
    setTimeout(() => this.onopen?.(new Event("open")), 0);
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob) {
    if (typeof data !== "string") return;
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
              serverVersion: "2.4.8",
              lanUrls: ["http://localhost:3000"],
              localDaemon: {
                enabled: this.localDaemonEnabled,
                platform: "macos",
                hostname: "test-mac",
                autoSaveToDownloads: this.localDaemonEnabled,
              },
              peers: [
                {
                  peerId: "1122334455667788",
                  device: {
                    name: "Pixel Phone",
                    platform: "android",
                    model: "Pixel",
                    formFactor: "phone",
                    publicKey: this.peerPublicKeyB64,
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
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  pushBinaryFrame(bytes: Uint8Array) {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    this.onmessage?.(new MessageEvent("message", { data: ab }));
  }

  close(code = 1006, reason = "connection lost") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

let roots: Root[] = [];
let containers: HTMLDivElement[] = [];

function mountComponent(node: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(node);
  });
  return container;
}

describe("M2 Web Client Hardening", () => {
  let peerPublicKeyB64 = "";
  let peerPrivateKey: CryptoKey | null = null;

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    FakeWebSocket.lastInstance = null;
    FakeWebSocket.nextPeerPublicKeyB64 = "";
    FakeWebSocket.nextLocalDaemonEnabled = false;
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
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => root.unmount());
    }
    for (const container of containers) {
      container.remove();
    }
    roots = [];
    containers = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("S-3: Clipboard URL sanitization (javascript: / data: XSS prevention)", () => {
    it("isSafeHttpUrl accepts only valid http: and https: URLs", () => {
      expect(isSafeHttpUrl("https://airbridge.fyi/privacy.html")).toBe(true);
      expect(isSafeHttpUrl("http://192.168.1.42:3000/?pair=ABC123")).toBe(true);
      expect(isSafeHttpUrl("javascript:alert(document.domain)")).toBe(false);
      expect(isSafeHttpUrl("JAVASCRIPT:alert(1)")).toBe(false);
      expect(isSafeHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
      expect(isSafeHttpUrl("vbscript:msgbox(1)")).toBe(false);
      expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);
      expect(isSafeHttpUrl("")).toBe(false);
    });

    it("downgrades incoming clipboard-beam with unsafe url protocol to text and suppresses Open URL anchor", async () => {
      const receivedItems: ClipboardBeamItem[] = [];
      const client = new WarpClient({
        wsUrl: "ws://localhost:3000/ws",
        enableWebRtc: false,
        storagePrefix: "s3-test",
        identityStore: null,
        onIncomingClipboard: (item) => receivedItems.push(item),
      });
      await client.start();
      const ws = FakeWebSocket.lastInstance!;
      ws.peerPublicKeyB64 = peerPublicKeyB64;

      await new Promise((r) => setTimeout(r, 20));
      const hello = ws.sentMessages.find((m) => m.type === "hello") as unknown as {
        device: { publicKey: string };
      };
      const session = await derivePeerSession(peerPrivateKey!, peerPublicKeyB64, hello.device.publicKey);

      const pushClip = async (payload: ControlPayload) => {
        const envelope = await encryptControlPayload(session.aesKey, payload);
        ws.pushServerMessage({ type: "transfer-control", from: "1122334455667788", envelope });
      };

      await pushClip({
        kind: "clipboard-beam",
        beamId: "xss-js-1",
        text: "javascript:alert(1)",
        contentType: "url",
        timestamp: Date.now(),
      });
      await pushClip({
        kind: "clipboard-beam",
        beamId: "xss-data-2",
        text: "data:text/html,<script>alert(2)</script>",
        contentType: "url",
        timestamp: Date.now() + 1,
      });

      await new Promise((r) => setTimeout(r, 40));
      expect(receivedItems).toHaveLength(2);
      expect(receivedItems[0]!.contentType).toBe("text");
      expect(receivedItems[1]!.contentType).toBe("text");

      // Even if a crafted item with contentType: 'url' is passed directly to ClipboardCenter / PairingDock,
      // the <a href> Open URL link must not render for non-http(s) protocols.
      const forcedUnsafeItems: ClipboardBeamItem[] = [
        {
          beamId: "forced-js",
          peerId: "1122334455667788",
          peerName: "Pixel Phone",
          direction: "incoming",
          text: "javascript:alert(1)",
          contentType: "url",
          timestamp: Date.now(),
          sasCode: "123 456",
        },
      ];
      const clipContainer = mountComponent(
        React.createElement(ClipboardCenter, {
          peers: [],
          items: forcedUnsafeItems,
          autoSync: true,
          hostClipboardActive: false,
          receiveEnabled: true,
          onToggleAutoSync: () => {},
          onToggleReceive: () => {},
          onSend: async () => {},
          onSendImage: async () => {},
          onClose: () => {},
        }),
      );
      expect(clipContainer.querySelector("a")).toBeNull();

      const dockContainer = mountComponent(
        React.createElement(PairingDock, {
          pairCode: "ABC123",
          lanUrls: ["http://localhost:3000"],
          transfers: [],
          clipboardItems: forcedUnsafeItems,
          onJoinPairCode: () => {},
          onRotatePairCode: () => {},
          onCancelTransfer: () => {},
        }),
      );
      const clipTabBtn = Array.from(dockContainer.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Clipboard"),
      );
      act(() => {
        clipTabBtn?.click();
      });
      expect(dockContainer.querySelector("a")).toBeNull();

      client.stop();
    });
  });

  describe("N-3: 4s fallbackTimer slow disk receiver completion", () => {
    it("waits for active slow disk chunk writes instead of aborting valid transfers at 4s", async () => {
      const realSetTimeout = globalThis.setTimeout;
      const flushAsyncCrypto = () => new Promise<void>((resolve) => realSetTimeout(resolve, 25));
      vi.useFakeTimers();

      const chunkBytes = new Uint8Array(64 * 1024).fill(0x42);
      const expectedSha = await sha256Hex([chunkBytes]);
      let receiveChunkStarted = false;

      // Stub fetch so receive-chunk takes 5,000ms (> 4,000ms fallbackTimer) before completing.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/daemon/received")) {
            return new Response(
              JSON.stringify({ ok: true, receivedChunks: [], receivedBytes: 0, receivedCount: 0 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes("/api/daemon/receive-chunk")) {
            receiveChunkStarted = true;
            await new Promise((r) => setTimeout(r, 5_000));
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          if (url.includes("/api/daemon/finalize")) {
            return new Response(
              JSON.stringify({
                savedPath: "/Users/test/Downloads/AirBridge/slow-video.bin",
                finalName: "slow-video.bin",
                sha256: expectedSha,
                bytes: chunkBytes.byteLength,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }),
      );

      let completedTransfer: TransferSessionView | null = null;
      const client = new WarpClient({
        wsUrl: "ws://localhost:3000/ws",
        enableWebRtc: false,
        autoAcceptAll: true,
        storagePrefix: "n3-slow-disk",
        identityStore: null,
        onTransferCompleted: (tr) => {
          completedTransfer = tr;
        },
      });

      FakeWebSocket.nextPeerPublicKeyB64 = peerPublicKeyB64;
      FakeWebSocket.nextLocalDaemonEnabled = true;

      const startPromise = client.start();
      await vi.advanceTimersByTimeAsync(10);
      await startPromise;

      const ws = FakeWebSocket.lastInstance!;
      ws.peerPublicKeyB64 = peerPublicKeyB64;
      ws.localDaemonEnabled = true;
      await vi.advanceTimersByTimeAsync(20);
      await flushAsyncCrypto();

      const hello = ws.sentMessages.find((m) => m.type === "hello") as unknown as {
        device: { publicKey: string };
      };
      const session = await derivePeerSession(peerPrivateKey!, peerPublicKeyB64, hello.device.publicKey);
      const pushControl = async (payload: ControlPayload) => {
        const envelope = await encryptControlPayload(session.aesKey, payload);
        ws.pushServerMessage({ type: "transfer-control", from: "1122334455667788", envelope });
      };

      const transferId = "0123456789abcdef";
      await pushControl({
        kind: "transfer-offer",
        transferId,
        totalBytes: chunkBytes.byteLength,
        createdAt: Date.now(),
        files: [
          {
            index: 0,
            name: "slow-video.bin",
            size: chunkBytes.byteLength,
            mimeType: "application/octet-stream",
            totalChunks: 1,
            chunkSize: 64 * 1024,
          },
        ],
      });

      // Let autoAcceptAll prepareDiskReceivers and enter 'transferring'
      await vi.advanceTimersByTimeAsync(50);
      await flushAsyncCrypto();

      // Push the encrypted chunk, file-complete, and transfer-complete
      const { iv, ciphertext } = await encryptBinaryChunk(session.aesKey, chunkBytes, 0, 0);
      const inner = encodeEncryptedChunkFrame({
        transferId,
        fileIndex: 0,
        chunkIndex: 0,
        iv,
        ciphertext,
      });
      ws.pushBinaryFrame(wrapRoutedRelayFrame("aabbccddeeff0011", "1122334455667788", inner));
      await vi.advanceTimersByTimeAsync(10);
      await flushAsyncCrypto();
      expect(receiveChunkStarted).toBe(true);

      await pushControl({
        kind: "file-complete",
        transferId,
        fileIndex: 0,
        sha256: expectedSha,
      });
      await pushControl({
        kind: "transfer-complete",
        transferId,
      });
      await flushAsyncCrypto();

      // Advance past the 4,000ms fallbackTimer while the 5,000ms disk chunk write is still in flight
      await vi.advanceTimersByTimeAsync(4_100);
      await flushAsyncCrypto();
      expect(client.getDiagnostics().fallbackTimerFires).toBe(1);

      // Now let the 5,000ms disk chunk write finish and finalize
      await vi.advanceTimersByTimeAsync(1_200);
      await flushAsyncCrypto();

      expect(completedTransfer).not.toBeNull();
      expect(completedTransfer!.status).toBe("completed");
      expect(completedTransfer!.receivedFiles).toHaveLength(1);
      expect(completedTransfer!.receivedFiles[0]!.verified).toBe(true);
      expect(completedTransfer!.receivedFiles[0]!.savedToMacPath).toContain("slow-video.bin");

      client.stop();
    });
  });

  describe("S-8: Offline-by-default RTCPeerConnection ICE servers", () => {
    it("defaults RTCPeerConnection iceServers to [] and honors optional opts.iceServers override", () => {
      const configs: RTCConfiguration[] = [];
      class FakeRTCPeerConnection {
        connectionState = "new";
        iceConnectionState = "new";
        signalingState = "stable";
        onicecandidate: unknown = null;
        ondatachannel: unknown = null;
        onconnectionstatechange: unknown = null;
        constructor(config?: RTCConfiguration) {
          configs.push(config ?? {});
        }
        createDataChannel() {
          return {
            binaryType: "arraybuffer",
            bufferedAmountLowThreshold: 0,
            readyState: "connecting",
            close: () => {},
          };
        }
        createOffer() {
          return Promise.resolve({ type: "offer", sdp: "v=0" });
        }
        setLocalDescription() {
          return Promise.resolve();
        }
        close() {}
      }
      vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);

      const defaultClient = new WarpClient({ storagePrefix: "s8-default", identityStore: null });
      (defaultClient as unknown as { getOrCreatePeerConnection: (id: string) => unknown }).getOrCreatePeerConnection(
        "peer-1",
      );
      expect(configs[0]?.iceServers).toEqual([]);
      defaultClient.stop();

      const customServers = [{ urls: "stun:192.168.1.1:3478" }];
      const customClient = new WarpClient({
        storagePrefix: "s8-custom",
        identityStore: null,
        iceServers: customServers,
      });
      (customClient as unknown as { getOrCreatePeerConnection: (id: string) => unknown }).getOrCreatePeerConnection(
        "peer-2",
      );
      expect(configs[1]?.iceServers).toEqual(customServers);
      customClient.stop();
    });
  });

  describe("B-3: ContinuityManager.destroy() listener cleanup", () => {
    it("clears frameListeners, videoListeners, and audioListeners on destroy()", () => {
      const manager = new ContinuityManager({
        sendControl: async () => {},
        sendFrame: () => true,
        sessionKey: async () => null,
        peer: () => undefined,
        isAuthorized: () => true,
        isPaired: () => true,
        peerIds: () => [],
        emit: () => {},
      });

      manager.subscribeScreenFrames("sess-1", () => {});
      manager.subscribeScreenVideo("sess-1", () => {});
      manager.subscribeScreenAudio("sess-1", () => {});

      const internals = manager as unknown as {
        frameListeners: Map<string, Set<unknown>>;
        videoListeners: Map<string, Set<unknown>>;
        audioListeners: Map<string, Set<unknown>>;
      };
      expect(internals.frameListeners.size).toBe(1);
      expect(internals.videoListeners.size).toBe(1);
      expect(internals.audioListeners.size).toBe(1);

      manager.destroy();

      expect(internals.frameListeners.size).toBe(0);
      expect(internals.videoListeners.size).toBe(0);
      expect(internals.audioListeners.size).toBe(0);
    });
  });

  describe("D8 & D9: Client diagnostics fields & macOS WKWebView Report on GitHub", () => {
    it("includes uiVersion, viewport, wsCloseCode, wsCloseReason, reconnectAttempts, rtcState, transferErrors, fallbackTimerFires, and clientErrorRing in collectDiagnostics()", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(JSON.stringify({ app: { version: "2.4.8" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const client = new WarpClient({
        wsUrl: "ws://localhost:3000/ws",
        enableWebRtc: false,
        storagePrefix: "d8-diag",
        identityStore: null,
      });
      await client.start();
      const ws = FakeWebSocket.lastInstance!;
      ws.close(1006, "abnormal closure");
      client.recordTransferError("deadbeef00112233", "chunk-sha256", "hash mismatch");
      client.recordClientError("ws-chunk", new Error("test frame error"));
      recordClientDiagnosticError("window.onerror", new Error("top-level error"));

      const diag = client.getDiagnostics();
      expect(diag.wsCloseCode).toBe(1006);
      expect(diag.wsCloseReason).toBe("abnormal closure");
      expect(diag.reconnectAttempts).toBe(1);
      expect(diag.transferErrors).toHaveLength(1);
      expect(diag.clientErrorRing.length).toBeGreaterThanOrEqual(1);

      const text = await collectDiagnostics({
        ...diag,
        connectionState: client.getSnapshot().connectionState,
      });
      const jsonMatch = text.match(/```json\n([\s\S]+)\n```/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![1]!) as {
        page: Record<string, unknown>;
        service: Record<string, unknown>;
      };

      expect(typeof parsed.page.uiVersion).toBe("string");
      expect(parsed.page.viewport).toEqual({
        width: window.innerWidth,
        height: window.innerHeight,
      });
      expect(parsed.page.wsCloseCode).toBe(1006);
      expect(parsed.page.wsCloseReason).toBe("abnormal closure");
      expect(parsed.page.reconnectAttempts).toBe(1);
      expect(parsed.page.rtcState).toEqual({});
      expect(Array.isArray(parsed.page.transferErrors)).toBe(true);
      expect(typeof parsed.page.fallbackTimerFires).toBe("number");
      expect(Array.isArray(parsed.page.clientErrorRing)).toBe(true);

      client.stop();
    });

    it("routes 'Report on GitHub' through airbridgeShell open-external inside macOS WKWebView without opening about:blank", async () => {
      const postMessage = vi.fn();
      Object.defineProperty(window, "webkit", {
        value: { messageHandlers: { airbridgeShell: { postMessage } } },
        configurable: true,
      });
      const openSpy = vi.fn();
      vi.stubGlobal("open", openSpy);

      let sent = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "/api/crashes") {
            return new Response(
              JSON.stringify({
                supported: true,
                sendVia: "github",
                reports: [
                  {
                    id: "2026-11-19T10-00-00-000Z-0001-abcdef",
                    createdAt: "2026-11-19T10:00:00Z",
                    kind: "uncaught-exception",
                    version: "2.4.8",
                    title: "Error: test",
                    sent,
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.endsWith("/send")) {
            sent = true;
            return new Response(
              JSON.stringify({
                via: "github",
                url: "https://github.com/DigantaDey/AirBridge/issues/new?title=crash",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ supported: false }), { status: 200 });
        }),
      );

      const container = mountComponent(
        React.createElement(ServiceStatusBar, {
          page: { connectionState: "connected" },
          connected: true,
        }),
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      const sendBtn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Report on GitHub",
      );
      expect(sendBtn).toBeDefined();
      await act(async () => {
        sendBtn!.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(openSpy).not.toHaveBeenCalledWith("about:blank", "_blank");
      expect(postMessage).toHaveBeenCalledWith({
        action: "open-external",
        url: "https://github.com/DigantaDey/AirBridge/issues/new?title=crash",
      });
      delete (window as unknown as { webkit?: unknown }).webkit;
    });
  });
});
