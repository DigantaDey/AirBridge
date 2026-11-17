// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffPrompt, type HandoffStatusView } from "../src/client/components/HandoffPrompt.js";

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

const offer = (state: string, extra: Record<string, unknown> = {}) => ({
  id: "0123456789abcdef", state, reason: "", deviceName: "Pixel 8", ssid: "AndroidShare_4821", via: "session",
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString(), ...extra,
});

async function render(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<HandoffPrompt pollMs={{ idle: 60_000, active: 60_000 }} />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("HandoffPrompt", () => {
  it("renders nothing when handoff is unavailable (remote page or disabled)", async () => {
    const el = await render(() => json({ error: "local only" }, 403));
    expect(el.textContent).toBe("");
    const el2 = await render(() => json({ enabled: false, offers: [] }));
    expect(el2.textContent).toBe("");
  });

  it("asks before joining and sends the decision", async () => {
    let status: HandoffStatusView = { enabled: true, policy: "ask", unsupportedReason: null, offers: [offer("pending") as never] };
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const el = await render((url, init) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined });
      if (url.endsWith("/respond")) {
        status = { ...status, offers: [offer("joining") as never] };
        return json(offer("joining"));
      }
      return json(status);
    });
    expect(el.textContent).toContain("Pixel 8 offers its hotspot “AndroidShare_4821”");
    expect(el.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(el.textContent).not.toContain("password");
    await act(async () => { button(el, "Join").click(); await new Promise((r) => setTimeout(r, 0)); });
    const respond = calls.find((c) => c.method === "POST")!;
    expect(respond.url).toBe("/api/handoff/0123456789abcdef/respond");
    expect(JSON.parse(respond.body!)).toEqual({ allow: true, always: false });
    expect(el.textContent).toContain("Joining “AndroidShare_4821”");
  });

  it("'Always' and 'Not now' map to the right request bodies", async () => {
    const bodies: unknown[] = [];
    const el = await render((url, init) => {
      if (init?.method === "POST") bodies.push(JSON.parse(init.body as string));
      return json({ enabled: true, policy: "ask", offers: [offer("pending")] });
    });
    await act(async () => { button(el, "Always for paired phones").click(); await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { button(el, "Not now").click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(bodies).toEqual([{ allow: true, always: true }, { allow: false, always: false }]);
  });

  it("shows the active link with a way to leave it", async () => {
    const calls: string[] = [];
    const el = await render((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return json({ enabled: true, policy: "always", offers: [offer("joined", { via: "bluetooth" })] });
    });
    expect(el.textContent).toContain("Direct link on Pixel 8's hotspot");
    await act(async () => { button(el, "Leave hotspot").click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toContain("POST /api/handoff/0123456789abcdef/end");
  });

  it("changes the policy and surfaces server errors", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const el = await render((url, init) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined });
      if (init?.method === "PUT") return json({ error: "Cross-origin request refused" }, 403);
      return json({ enabled: true, policy: "ask", offers: [] });
    });
    const select = el.querySelector("select")!;
    expect(select.value).toBe("ask");
    await act(async () => {
      select.value = "off";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/handoff/settings");
    expect(JSON.parse(put.body!)).toEqual({ policy: "off" });
    expect(el.textContent).toContain("Cross-origin request refused");
  });
});
