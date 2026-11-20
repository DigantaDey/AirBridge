// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairingDock } from "../src/client/components/PairingDock.js";
import { WarpClient } from "../src/client/engine/warpClient.js";
import type { LanEndpoint } from "../src/shared/protocol.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PIN = "Z".repeat(43);
const endpoints: LanEndpoint[] = [
  { url: "https://10.205.95.167:3000", address: "10.205.95.167", interface: "en0", kind: "wifi" },
  { url: "https://10.42.61.23:3000", address: "10.42.61.23", interface: "en7", kind: "ethernet" },
];

describe("PairingDock endpoint choice (multi-network computer)", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  async function copiedLink(): Promise<string> {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const button = container!.querySelector<HTMLButtonElement>('button[title="Copy direct pairing URL"]')!;
    await act(async () => button.click());
    return writeText.mock.calls.at(-1)![0];
  }

  it("shows every network, encodes all of them in the QR, and lets the user pick the primary", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PairingDock
          pairCode="ABC234"
          lanUrls={endpoints.map((e) => e.url)}
          lanEndpoints={endpoints}
          tlsPin={PIN}
          transfers={[]}
          clipboardItems={[]}
          onJoinPairCode={() => {}}
          onRotatePairCode={() => {}}
          onCancelTransfer={() => {}}
        />,
      );
    });

    const group = container.querySelector('[data-testid="pairing-endpoints"]');
    expect(group?.textContent).toContain("2 networks");
    const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((r) => r.textContent)).toEqual(["en0 · 10.205.95.167", "en7 · 10.42.61.23"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    let link = new URL(await copiedLink());
    expect(link.host).toBe("10.205.95.167:3000");
    expect(link.searchParams.get("alt")).toBe("10.42.61.23");
    expect(link.searchParams.get("ca")).toBe(PIN);

    await act(async () => radios[1]!.click());
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    link = new URL(await copiedLink());
    expect(link.host).toBe("10.42.61.23:3000");
    expect(link.searchParams.get("alt")).toBe("10.205.95.167");
    expect(link.searchParams.get("pair")).toBe("ABC234");
  });

  it("hides the picker for a single network", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PairingDock
          pairCode="ABC234"
          lanUrls={[endpoints[1]!.url]}
          lanEndpoints={[endpoints[1]!]}
          transfers={[]}
          clipboardItems={[]}
          onJoinPairCode={() => {}}
          onRotatePairCode={() => {}}
          onCancelTransfer={() => {}}
        />,
      );
    });
    expect(container.querySelector('[data-testid="pairing-endpoints"]')).toBeNull();
  });
});

describe("WarpClient network updates", () => {
  it("applies welcome endpoints and later `network` changes to the snapshot", () => {
    const client = new WarpClient({ wsUrl: "ws://127.0.0.1:1/ws", enableWebRtc: false });
    const dispatch = (msg: unknown) =>
      (client as unknown as { handleServerMessage: (m: unknown) => void }).handleServerMessage(msg);
    dispatch({ type: "network", lanUrls: [endpoints[1]!.url], lanEndpoints: [endpoints[1]], tlsPin: PIN });
    const snap = client.getSnapshot();
    expect(snap.lanUrls).toEqual([endpoints[1]!.url]);
    expect(snap.lanEndpoints).toEqual([endpoints[1]]);
    expect(snap.tlsPin).toBe(PIN);
    client.stop();
  });
});

describe("PairingDock firewall notice (single hotspot address, phone times out)", () => {
  it("renders the block notice with the unblock command, and nothing once allowed", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (app: "blocked" | "allowed") =>
      act(async () => {
        root.render(
          <PairingDock
            pairCode="ABC234"
            lanUrls={["https://10.205.95.167:3000"]}
            tlsPin={PIN}
            hostFirewall={{ enabled: true, blockAll: false, stealth: true, app, appPath: "/Applications/AirBridge" }}
            transfers={[]}
            clipboardItems={[]}
            onJoinPairCode={() => {}}
            onRotatePairCode={() => {}}
            onCancelTransfer={() => {}}
          />,
        );
      });
    try {
      await render("blocked");
      const notice = container.querySelector('[data-testid="firewall-notice"]');
      expect(notice?.getAttribute("role")).toBe("alert");
      expect(notice?.textContent).toContain("macOS Firewall is blocking AirBridge");
      expect(notice?.querySelector("code")?.textContent).toBe(
        'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "/Applications/AirBridge" --unblockapp "/Applications/AirBridge"',
      );
      // Single address: no multi-network chooser.
      expect(container.querySelector('[data-testid="pairing-endpoints"]')).toBeNull();
      await render("allowed");
      expect(container.querySelector('[data-testid="firewall-notice"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("PairingDock while the local service is unreachable", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  async function copiedLink(): Promise<string> {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const button = container!.querySelector<HTMLButtonElement>('button[title="Copy direct pairing URL"]')!;
    await act(async () => button.click());
    return writeText.mock.calls.at(-1)![0];
  }

  it("hides the QR and the copy link while the service is unreachable (never a stale code)", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const el = container;
    const render = (connected: boolean) =>
      root!.render(
        <PairingDock
          connected={connected}
          pairCode="ABC234"
          lanUrls={endpoints.map((e) => e.url)}
          lanEndpoints={endpoints}
          tlsPin={PIN}
          transfers={[]}
          clipboardItems={[]}
          onJoinPairCode={() => {}}
          onRotatePairCode={() => {}}
          onCancelTransfer={() => {}}
        />,
      );
    await act(async () => render(false));
    expect(el.querySelector('[data-testid="pairing-qr-offline"]')?.textContent).toContain("Waiting for the AirBridge service");
    const qrBox = el.querySelector('[data-testid="pairing-qr-offline"]')!.parentElement!;
    expect(qrBox.querySelector("svg")).toBeNull();
    const copy = el.querySelector<HTMLButtonElement>('button[title="Copy direct pairing URL"]');
    expect(copy?.disabled ?? true).toBe(true);

    await act(async () => render(true));
    expect(el.querySelector('[data-testid="pairing-qr-offline"]')).toBeNull();
    expect(await copiedLink()).toContain("pair=ABC234");
  });
});
