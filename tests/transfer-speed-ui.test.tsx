// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PairingDock } from "../src/client/components/PairingDock.js";
import {
  TransferSpeed,
  formatTransferSpeedLabel,
} from "../src/client/components/TransferSpeed.js";
import type { TransferSessionView } from "../src/client/engine/warpClient.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function activeTransfer(
  direction: "incoming" | "outgoing",
  speedBytesPerSec: number,
): TransferSessionView {
  return {
    transferId: direction === "incoming" ? "aaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbb",
    peerId: "1122334455667788",
    peerName: "Test device",
    peerPlatform: "android",
    sasCode: "123 · 456",
    direction,
    status: "transferring",
    transport: "ws-relay",
    files: [{
      index: 0,
      name: `${direction}.bin`,
      size: 1024,
      mimeType: "application/octet-stream",
      totalChunks: 1,
      chunkSize: 256 * 1024,
    }],
    totalBytes: 1024,
    transferredBytes: 512,
    speedBytesPerSec,
    etaSeconds: null,
    startedAt: Date.now(),
    receivedFiles: [],
  };
}

describe("live transfer speed labels", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("shows Upload on the sender and Download on the receiver", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PairingDock
          pairCode=""
          lanUrls={[]}
          transfers={[
            activeTransfer("outgoing", 12 * 1024 * 1024),
            activeTransfer("incoming", 4 * 1024 * 1024),
          ]}
          clipboardItems={[]}
          onJoinPairCode={() => {}}
          onRotatePairCode={() => {}}
          onCancelTransfer={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("Upload 12.0 MB/s");
    expect(container.textContent).toContain("Download 4.00 MB/s");
  });


  it("renders one accessible live indicator for each direction", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <>
          <TransferSpeed transfer={activeTransfer("outgoing", 12 * 1024 * 1024)} />
          <TransferSpeed transfer={activeTransfer("incoming", 4 * 1024 * 1024)} />
        </>,
      );
    });

    const indicators = container.querySelectorAll('[data-testid="transfer-speed"]');
    expect(indicators).toHaveLength(2);
    expect(indicators[0].textContent).toBe("Upload 12.0 MB/s");
    expect(indicators[0].getAttribute("aria-label")).toBe("Upload 12.0 MB/s");
    expect(indicators[0].getAttribute("data-direction")).toBe("outgoing");
    expect(indicators[0].getAttribute("aria-live")).toBe("polite");
    expect(indicators[1].textContent).toBe("Download 4.00 MB/s");
    expect(indicators[1].getAttribute("data-direction")).toBe("incoming");
    expect(formatTransferSpeedLabel(activeTransfer("outgoing", 1024))).toBe(
      "Upload 1.00 KB/s",
    );
  });

  it("adds the ETA only while the estimate is useful", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const withEta = {
      ...activeTransfer("incoming", 8 * 1024 * 1024),
      etaSeconds: 9,
    };
    await act(async () => {
      root!.render(<TransferSpeed transfer={withEta} />);
    });
    expect(container.textContent).toContain("Download 8.00 MB/s · 9s left");

    await act(async () => {
      root!.render(<TransferSpeed transfer={withEta} showEta={false} />);
    });
    expect(container.textContent).not.toContain("left");
  });

});
