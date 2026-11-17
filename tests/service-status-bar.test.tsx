// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceStatusBar, collectDiagnostics, copyText } from "../src/client/components/ServiceStatusBar.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

async function render(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ServiceStatusBar page={{ connectionState: "connected" }} connected />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

describe("ServiceStatusBar", () => {
  it("offers a one-click restart when a verified update is staged", async () => {
    const calls: string[] = [];
    const el = await render((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/update" && !init?.method) return json({ supported: true, available: true, state: "ready", latest: "0.0.7", current: "0.0.6", releaseUrl: "https://github.com/x" });
      return json({ supported: true, state: "installed" });
    });
    expect(el.textContent).toContain("AirBridge 0.0.7 is ready");
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Restart to update")!;
    await act(async () => { button.click(); });
    expect(calls).toContain("POST /api/update/install");
    expect(el.textContent).toContain("Restarting…");
  });

  it("shows nothing about updates when none is ready", async () => {
    const el = await render(() => json({ supported: false, current: "dev" }));
    expect(el.textContent).not.toContain("is ready");
    expect(el.textContent).toContain("Copy diagnostics");
  });

  it("copies a diagnostics report", async () => {
    const writeText = vi.fn((_t: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const el = await render((url) => (url === "/api/diagnostics" ? json({ app: { version: "0.0.6" } }) : json({ supported: false })));
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Copy diagnostics")!;
    await act(async () => { button.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]![0]).toContain('"version": "0.0.6"');
    expect(el.textContent).toContain("Diagnostics copied");
  });
});

describe("diagnostics clipboard fallback", () => {
  it("uses the native macOS pasteboard when browser clipboard APIs reject the copy", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(() => Promise.reject(new Error("permission denied"))) }, configurable: true });
    const postMessage = vi.fn();
    Object.defineProperty(window, "webkit", { value: { messageHandlers: { airbridgeShell: { postMessage } } }, configurable: true });
    expect(await copyText("support diagnostics" )).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ action: "copy-text", text: "support diagnostics" });
  });
});

describe("collectDiagnostics", () => {
  it("still reports page state when the service is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const text = await collectDiagnostics({ connectionState: "disconnected" });
    expect(text).toContain("service unreachable: Failed to fetch");
    expect(text).toContain('"connectionState": "disconnected"');
  });
});

describe("ServiceStatusBar: staged rollout and crash reports", () => {
  it("explains a staged rollout and lets the user get the update now", async () => {
    const calls: string[] = [];
    const el = await render((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/update" && !init?.method) {
        return json({ supported: true, available: true, state: "deferred", latest: "0.0.7", rollout: { eligible: false, percent: 10, halted: false, eligibleAt: "2026-11-21T10:00:00Z", forced: false, reason: "rolling out gradually (10% so far)" } });
      }
      if (url === "/api/update/check") return json({ supported: true, available: true, state: "ready", latest: "0.0.7" });
      return json({ supported: false });
    });
    expect(el.textContent).toContain("AirBridge 0.0.7 is rolling out");
    expect(el.textContent).toContain("10% so far");
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Get it now")!;
    await act(async () => { button.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toContain("POST /api/update/check");
    expect(el.textContent).toContain("AirBridge 0.0.7 is ready");
  });

  it("shows an unsent crash report, previews it, and sends only on request", async () => {
    const calls: string[] = [];
    let sent = false;
    const open = vi.fn(() => ({ location: { href: "" }, close: vi.fn() }));
    vi.stubGlobal("open", open);
    const el = await render((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/crashes") return json({ supported: true, sendVia: "github", reports: [{ id: "2026-11-16T10-00-00-000Z-0001-abcdef", createdAt: "2026-11-16T10:00:00Z", kind: "uncaught-exception", version: "0.0.6", title: "TypeError: boom", sent }] });
      if (url.endsWith("/send")) { sent = true; return json({ via: "github", url: "https://github.com/DigantaDey/AirBridge/issues/new?title=x" }); }
      if (url.startsWith("/api/crashes/")) return json({ stack: "TypeError: boom\n    at f (a.js:1:1)" });
      return json({ supported: false });
    });
    expect(el.textContent).toContain("AirBridge hit an unexpected error");
    expect(calls.some((c) => c.startsWith("POST /api/crashes"))).toBe(false); // nothing sent by itself

    const reviewBtn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Review report")!;
    await act(async () => { reviewBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(el.querySelector(".crash-preview")?.textContent).toContain("TypeError: boom");

    const sendBtn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Report on GitHub")!;
    await act(async () => { sendBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toContain("POST /api/crashes/2026-11-16T10-00-00-000Z-0001-abcdef/send");
    expect(open).toHaveBeenCalled();
    expect(el.textContent).not.toContain("AirBridge hit an unexpected error"); // sent reports are not shown again
  });
});
