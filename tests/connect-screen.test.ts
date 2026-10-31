// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

/**
 * The unpaired connect screen lives in the Android app's assets, but it is
 * plain HTML + the `window.AirBridgeAndroid` contract, so it can be driven here
 * exactly as the WebView drives it. These tests keep the page and ShellBridge.kt
 * in sync: a renamed bridge method fails CI instead of the phone.
 */
const html = readFileSync(
  path.join(process.cwd(), "android/app/src/main/assets/shell/connect.html"),
  "utf8",
);

interface FakeBridge {
  state: () => string;
  nearbyHosts: () => string;
  connect: (address: string) => string;
  scanQr: () => boolean;
  forgetComputer: () => boolean;
  copyText?: (text: string) => boolean;
}

interface Mounted {
  dom: JSDOM;
  window: Window & typeof globalThis;
  document: Document;
  bridge: FakeBridge;
}

const opened: JSDOM[] = [];

function mount(bridge?: FakeBridge): Mounted {
  const created = bridge ?? {
    state: () => JSON.stringify({ paired: false, address: "", pairCode: "", camera: true }),
    nearbyHosts: () => "[]",
    connect: () => "",
    scanQr: () => true,
    forgetComputer: () => true,
  };
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://shell.airbridge.local/",
    beforeParse(window) {
      if (bridge) {
        (window as unknown as { AirBridgeAndroid: FakeBridge }).AirBridgeAndroid = created;
      }
    },
  });
  opened.push(dom);
  return { dom, window: dom.window as unknown as Window & typeof globalThis, document: dom.window.document, bridge: created };
}

afterEach(() => {
  while (opened.length) opened.pop()?.window.close();
});

describe("unpaired connect screen", () => {
  it("renders the shell without a paired computer", () => {
    const { document } = mount();
    expect(document.querySelector("h1")?.textContent).toBe("Connect to your computer");
    expect(document.getElementById("state-label")?.textContent).toBe("Not connected");
    expect(document.getElementById("empty")?.hidden).toBe(false);
    expect(document.getElementById("hosts")?.hidden).toBe(true);
  });

  it("lists computers found over mDNS and connects to the chosen one", () => {
    const connect = vi.fn(() => "");
    const bridge: FakeBridge = {
      state: () => JSON.stringify({ paired: false, address: "", pairCode: "", camera: true }),
      nearbyHosts: () =>
        JSON.stringify([
          { name: "Diganta's MacBook", address: "https://192.168.1.5" },
          { name: "Studio iMac", address: "https://192.168.1.9:3411" },
        ]),
      connect,
      scanQr: () => true,
      forgetComputer: () => true,
    };
    const { document, window } = mount(bridge);
    (window as unknown as { AirBridgeConnect: { refresh: () => void } }).AirBridgeConnect.refresh();

    const rows = document.querySelectorAll(".device-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("strong")?.textContent).toBe("Diganta's MacBook");
    expect(rows[0].querySelector("small")?.textContent).toBe("https://192.168.1.5");
    expect(document.getElementById("empty")?.hidden).toBe(true);

    (rows[1].querySelector("button") as HTMLButtonElement).click();
    expect(connect).toHaveBeenCalledWith("https://192.168.1.9:3411");
  });

  it("submits a typed address and reports the error when it cannot connect", () => {
    let answer = "";
    const connect = vi.fn((address: string) => {
      expect(address).toBe("192.168.1.5:3411");
      return answer;
    });
    const { document } = mount({
      state: () => JSON.stringify({ paired: false, address: "", pairCode: "", camera: true }),
      nearbyHosts: () => "[]",
      connect,
      scanQr: () => true,
      forgetComputer: () => true,
    });

    const input = document.getElementById("address") as HTMLInputElement;
    input.value = "  192.168.1.5:3411  ";
    (document.getElementById("form") as HTMLFormElement).dispatchEvent(
      new (input.ownerDocument.defaultView as typeof globalThis).Event("submit", { cancelable: true }),
    );
    expect(connect).toHaveBeenCalledTimes(1);

    // The rejected address surfaces inline instead of silently doing nothing.
    answer = "Enter your computer's address, e.g. 192.168.1.5:3411";
    (document.getElementById("form") as HTMLFormElement).dispatchEvent(
      new (input.ownerDocument.defaultView as typeof globalThis).Event("submit", { cancelable: true }),
    );
    const error = document.getElementById("error") as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(answer);
  });

  it("asks the shell to open the QR scanner", () => {
    const scanQr = vi.fn(() => true);
    const { document } = mount({
      state: () => JSON.stringify({ paired: false, address: "", pairCode: "", camera: true }),
      nearbyHosts: () => "[]",
      connect: () => "",
      scanQr,
      forgetComputer: () => true,
    });

    (document.getElementById("scan") as HTMLButtonElement).click();
    (document.getElementById("scan-header") as HTMLButtonElement).click();
    expect(scanQr).toHaveBeenCalledTimes(2);
  });

  it("explains itself when the camera is missing", () => {
    const { document } = mount({
      state: () => JSON.stringify({ paired: false, address: "", pairCode: "", camera: false }),
      nearbyHosts: () => "[]",
      connect: () => "",
      scanQr: () => false,
      forgetComputer: () => true,
    });

    (document.getElementById("scan") as HTMLButtonElement).click();
    const error = document.getElementById("error") as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("no camera");
    expect(document.getElementById("shell-note")?.textContent).toContain("no camera");
  });

  it("pre-fills the last paired address so retrying is one tap", () => {
    const { document } = mount({
      state: () =>
        JSON.stringify({ paired: true, address: "https://192.168.1.5", pairCode: "ABCDEF", camera: true }),
      nearbyHosts: () => "[]",
      connect: () => "",
      scanQr: () => true,
      forgetComputer: () => true,
    });

    expect(document.getElementById("state-label")?.textContent).toBe("Paired with https://192.168.1.5");
    // Pre-filled, so a retry (or a reconnect after the computer was asleep) is one tap.
    expect((document.getElementById("address") as HTMLInputElement).value).toBe("https://192.168.1.5");
  });

  it("degrades gracefully when the page is opened outside the app", () => {
    const { document } = mount();
    (document.getElementById("scan") as HTMLButtonElement).click();
    const error = document.getElementById("error") as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("AirBridge app");
  });
});
