// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ContinuityAlerts,
  ContinuityCenter,
  activeCallCount,
  callStatusLabel,
  featureGuidance,
  screenEndedLabel,
  type ContinuityClient,
} from "../src/client/components/ContinuityCenter.js";
import type { CallView, ContinuitySnapshot, ScreenFrame, ScreenFrameSource, ScreenShareView } from "../src/client/engine/continuity.js";
import { createStreamScreenSource, fitWithin } from "../src/client/engine/screenCapture.js";
import type { PeerSummary } from "../src/shared/protocol.js";
import type { ContactCard } from "../src/shared/continuity.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PHONE = "1122334455667788";
const MAC = "8877665544332211";

const phone: PeerSummary = {
  peerId: PHONE,
  device: { name: "Pixel 9", platform: "android", model: "Pixel", formFactor: "phone", publicKey: "pk-phone" },
  discoveryScope: "paired",
  connectedAt: 1,
};
const mac: PeerSummary = {
  peerId: MAC,
  device: { name: "Studio Mac", platform: "macos", model: "Mac", formFactor: "desktop", publicKey: "pk-mac" },
  discoveryScope: "paired",
  connectedAt: 2,
};

const CONTACTS: ContactCard[] = [
  { name: "Ada Lovelace", phones: [{ number: "+44 20 7946 0958", label: "mobile" }], emails: [{ address: "ada@example.org" }] },
  { name: "Alan Turing", phones: [{ number: "+44 161 496 0000", label: "work" }], emails: [], organization: "Bletchley Park" },
  { name: "Grace Hopper", phones: [], emails: [{ address: "grace@navy.mil", label: "work" }] },
];

function snapshot(partial: Partial<ContinuitySnapshot> = {}): ContinuitySnapshot {
  return {
    peerFeatures: { [PHONE]: ["contacts.receive", "contacts.provide", "calls.control", "screen.source"], [MAC]: ["contacts.receive", "screen.view"] },
    calls: [],
    screenShares: [],
    screenRequests: [],
    sharedContacts: [],
    ...partial,
  };
}

function fakeClient() {
  const frameListeners = new Map<string, (frame: ScreenFrame) => void>();
  const client = {
    requestContacts: vi.fn(async (_peer: string, opts?: { query?: string }) => ({
      contacts: opts?.query ? CONTACTS.filter((c) => c.name.toLowerCase().includes(opts.query!.toLowerCase())) : CONTACTS,
      total: CONTACTS.length,
      truncated: false,
    })),
    shareContacts: vi.fn(async (peerId: string, contacts: ContactCard[]) => ({
      shareId: "aaaaaaaaaaaaaaaa", peerId, peerName: "Pixel 9", direction: "outgoing" as const, contacts, vcard: "BEGIN:VCARD", timestamp: 1,
    })),
    clearSharedContacts: vi.fn(),
    answerCall: vi.fn(async () => ({ ok: true })),
    rejectCall: vi.fn(async () => ({ ok: true })),
    hangUpCall: vi.fn(async () => ({ ok: true })),
    dialNumber: vi.fn(async () => ({ ok: true, callId: "bbbbbbbbbbbbbbbb" })),
    requestScreenShare: vi.fn(() => "cccccccccccccccc"),
    stopScreenShare: vi.fn(),
    subscribeScreenFrames: vi.fn((sessionId: string, listener: (frame: ScreenFrame) => void) => {
      frameListeners.set(sessionId, listener);
      return () => frameListeners.delete(sessionId);
    }),
    acceptScreenShare: vi.fn(),
    declineScreenShare: vi.fn(),
  };
  return { client, frameListeners };
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render(element: React.ReactElement) {
  await act(async () => { root!.render(element); });
  await flush();
}

async function flush(ms = 0) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

function button(label: string | RegExp, scope: ParentNode = container): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find((b) =>
    typeof label === "string" ? b.textContent?.trim() === label || b.getAttribute("aria-label") === label : label.test(b.textContent ?? ""),
  );
  if (!found) throw new Error(`button ${label} not found in: ${Array.from(scope.querySelectorAll("button")).map((b) => b.textContent).join(" | ")}`);
  return found;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const ringing: CallView = {
  callId: "0123456789abcdef", state: "ringing", direction: "incoming", number: "+1 555 0100", name: "Mum",
  updatedAt: Date.now(), actions: ["answer", "reject"], peerId: PHONE, peerName: "Pixel 9",
};

describe("featureGuidance", () => {
  it("tells the user exactly what to enable", () => {
    expect(featureGuidance("calls", undefined, undefined)).toMatch(/Pair a phone/);
    expect(featureGuidance("calls", { ...phone, discoveryScope: "nearby" }, undefined)).toMatch(/not paired/);
    expect(featureGuidance("calls", phone, undefined)).toMatch(/Update AirBridge/);
    expect(featureGuidance("calls", phone, ["contacts.receive"])).toMatch(/Turn on Calls in AirBridge on Pixel 9/);
    expect(featureGuidance("contacts", phone, ["contacts.receive"])).toMatch(/Turn on Contacts/);
    expect(featureGuidance("screen", phone, [])).toMatch(/Turn on Screen sharing/);
    expect(featureGuidance("screen", mac, ["screen.view"])).toMatch(/can't share its screen from this browser/);
    expect(featureGuidance("calls", mac, ["screen.view"])).toMatch(/can't make phone calls/);
    expect(featureGuidance("calls", phone, ["calls.control"])).toBeNull();
  });

  it("labels call states and durations", () => {
    expect(callStatusLabel(ringing, 0)).toBe("Incoming call");
    expect(callStatusLabel({ ...ringing, state: "dialing" }, 0)).toBe("Calling…");
    expect(callStatusLabel({ ...ringing, state: "active", connectedAt: 1_000 }, 66_000)).toBe("1:05");
    expect(callStatusLabel({ ...ringing, state: "active", connectedAt: 1_000 }, 3_726_000)).toBe("1:02:05");
    expect(activeCallCount(snapshot({ calls: [ringing, { ...ringing, callId: "x", state: "ended" }] }))).toBe(1);
    expect(activeCallCount(undefined)).toBe(0);
  });

  it("explains how a screen share ended", () => {
    const base: ScreenShareView = { sessionId: "s", peerId: PHONE, peerName: "Pixel 9", role: "viewer", state: "declined", width: 0, height: 0, maxWidth: 1280, maxFps: 15, frames: 0, fps: 0, kbps: 0, startedAt: 0, updatedAt: 0 };
    expect(screenEndedLabel({ ...base, reason: "Not now" })).toBe("Pixel 9 declined: Not now");
    expect(screenEndedLabel({ ...base, state: "stopped" })).toBe("Screen sharing ended.");
    expect(screenEndedLabel({ ...base, state: "unsupported", reason: "No capture" })).toBe("No capture");
  });
});

describe("ContinuityCenter", () => {
  it("loads, searches, exports and calls contacts from the phone", async () => {
    const { client } = fakeClient();
    const createUrl = vi.fn(() => "blob:vcf");
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });

    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot()} initialTab="contacts" onClose={() => {}} />);
    expect(client.requestContacts).toHaveBeenCalledWith(PHONE);
    expect(container.querySelectorAll('[aria-label="Contacts"] > li')).toHaveLength(3);

    type(container.querySelector('input[aria-label="Search contacts"]')!, "bletchley");
    await flush();
    const rows = container.querySelectorAll('[aria-label="Contacts"] > li');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Alan Turing");

    act(() => button("Save Alan Turing as vCard").click());
    expect(clicks).toContain("Alan Turing.vcf");
    const blob = (createUrl.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toContain("text/vcard");
    expect(await blob.text()).toContain("FN:Alan Turing");

    // "Call" jumps to the Calls tab and dials the normalized number once.
    await act(async () => { button("Call Alan Turing +44 161 496 0000").click(); });
    await flush();
    expect(container.querySelector(".continuity-modal h2")?.textContent).toBe("Calls");
    expect(client.dialNumber).toHaveBeenCalledTimes(1);
    expect(client.dialNumber).toHaveBeenCalledWith(PHONE, "+441614960000");
  });

  it("sends a contact card to the phone", async () => {
    const { client } = fakeClient();
    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot()} initialTab="contacts" onClose={() => {}} />);
    act(() => button(/Send a contact to Pixel 9/).click());
    type(container.querySelector('input[aria-label="Contact name"]')!, "Katherine Johnson");
    type(container.querySelector('input[aria-label="Contact phone"]')!, "+1 757 555 0199");
    await act(async () => { button("Send").click(); });
    await flush();
    expect(client.shareContacts).toHaveBeenCalledWith(PHONE, [{ name: "Katherine Johnson", phones: [{ number: "+1 757 555 0199", label: "mobile" }], emails: [] }]);
    expect(container.textContent).toContain("Sent Katherine Johnson to Pixel 9.");
  });

  it("shows received contact cards with save and clear", async () => {
    const { client } = fakeClient();
    const shared = [{ shareId: "dddddddddddddddd", peerId: PHONE, peerName: "Pixel 9", direction: "incoming" as const, contacts: [CONTACTS[0]], vcard: "BEGIN:VCARD", timestamp: Date.now() }];
    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot({ sharedContacts: shared })} initialTab="contacts" onClose={() => {}} />);
    const received = container.querySelector('[aria-label="Received contacts"]')!;
    expect(received.textContent).toContain("Ada Lovelace");
    expect(received.textContent).toContain("From Pixel 9");
    act(() => button("Clear").click());
    expect(client.clearSharedContacts).toHaveBeenCalled();
  });

  it("dials from the keypad and surfaces phone errors", async () => {
    const { client } = fakeClient();
    client.dialNumber.mockResolvedValueOnce({ ok: false, error: "Finish the current call on the phone first." } as never);
    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot()} initialTab="calls" onClose={() => {}} />);
    const callButton = button(/Call from Pixel 9/);
    expect(callButton.disabled).toBe(true);
    for (const d of ["5", "5", "5", "0", "1", "0", "0"]) act(() => button(d).click());
    expect((container.querySelector('input[aria-label="Phone number"]') as HTMLInputElement).value).toBe("5550100");
    await act(async () => { callButton.click(); });
    await flush();
    expect(client.dialNumber).toHaveBeenCalledWith(PHONE, "5550100");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Finish the current call on the phone first.");
    expect(container.textContent).toContain("Audio plays on Pixel 9");
  });

  it("refuses * and # service codes and explains why", async () => {
    const { client } = fakeClient();
    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot()} initialTab="calls" onClose={() => {}} />);
    const keypad = container.querySelector('[aria-label="Keypad"]')!;
    expect(Array.from(keypad.querySelectorAll("button")).map((b) => b.textContent || b.getAttribute("aria-label"))).not.toContain("*");
    const input = container.querySelector('input[aria-label="Phone number"]') as HTMLInputElement;
    type(input, "**21*5550100#");
    expect(button(/Call from Pixel 9/).disabled).toBe(true);
    expect(container.textContent).toContain("can only be dialed on Pixel 9 itself");
    act(() => button("Delete").click());
    expect(input.value).toBe("**21*5550100");
    type(input, "+1 555 0100");
    expect(button(/Call from Pixel 9/).disabled).toBe(false);
    expect(container.textContent).not.toContain("can only be dialed");
  });

  it("answers, declines and hangs up calls", async () => {
    const { client } = fakeClient();
    const active: CallView = { ...ringing, callId: "fedcba9876543210", state: "active", connectedAt: Date.now() - 5_000, actions: ["hangup"] };
    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot({ calls: [ringing, active] })} initialTab="calls" onClose={() => {}} />);
    const list = container.querySelector('[aria-label="Calls"]')!;
    expect(list.textContent).toContain("Mum");
    expect(list.textContent).toContain("+1 555 0100 · Incoming call · Pixel 9");
    await act(async () => { button(/Answer/, list).click(); });
    expect(client.answerCall).toHaveBeenCalledWith(PHONE, ringing.callId);
    await act(async () => { button("Decline", list).click(); });
    expect(client.rejectCall).toHaveBeenCalledWith(PHONE, ringing.callId);
    await act(async () => { button(/Hang up/, list).click(); });
    expect(client.hangUpCall).toHaveBeenCalledWith(PHONE, active.callId);
  });

  it("guides when the phone hasn't enabled a feature and lets the user switch devices", async () => {
    const { client } = fakeClient();
    const snap = snapshot({ peerFeatures: { [PHONE]: ["contacts.receive"], [MAC]: ["contacts.receive", "screen.source"] } });
    await render(<ContinuityCenter client={client} peers={[phone, mac]} continuity={snap} initialTab="screen" onClose={() => {}} />);
    // Defaults to the device that can share its screen.
    expect((container.querySelector('select[aria-label="Device"]') as HTMLSelectElement).value).toBe(MAC);
    act(() => button("Calls").click());
    expect(container.querySelector(".continuity-guidance")?.textContent).toMatch(/Turn on Calls|can't make phone calls/);
    expect(client.requestContacts).not.toHaveBeenCalled();
  });

  it("requests a screen, renders encrypted frames and stops", async () => {
    const { client, frameListeners } = fakeClient();
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:frame-1"), revokeObjectURL: vi.fn() });
    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot()} initialTab="screen" onClose={() => {}} />);
    const select = container.querySelector('select[aria-label="Screen quality"]') as HTMLSelectElement;
    act(() => {
      select.value = "high";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => button(/View Pixel 9 screen/).click());
    expect(client.requestScreenShare).toHaveBeenCalledWith(PHONE, { maxWidth: 1920, maxFps: 30 });

    const share: ScreenShareView = { sessionId: "cccccccccccccccc", peerId: PHONE, peerName: "Pixel 9", role: "viewer", state: "pending", width: 0, height: 0, maxWidth: 1920, maxFps: 30, frames: 0, fps: 0, kbps: 0, startedAt: 1, updatedAt: 1 };
    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot({ screenShares: [share] })} initialTab="screen" onClose={() => {}} />);
    expect(container.textContent).toContain("Waiting for Pixel 9 to allow screen sharing");

    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot({ screenShares: [{ ...share, state: "active", width: 1080, height: 2400, fps: 24, kbps: 3200 }] })} initialTab="screen" onClose={() => {}} />);
    act(() => frameListeners.get("cccccccccccccccc")!({ sessionId: share.sessionId, peerId: PHONE, seq: 1, width: 1080, height: 2400, mimeType: "image/jpeg", data: new Uint8Array([0xff, 0xd8]) }));
    const img = container.querySelector("img.screen-frame") as HTMLImageElement;
    expect(img.src).toBe("blob:frame-1");
    expect(img.className).not.toContain("is-empty");
    expect(container.textContent).toContain("1080×2400 · 24 fps · 3.2 Mbps");
    act(() => button("Stop viewing").click());
    expect(client.stopScreenShare).toHaveBeenCalledWith("cccccccccccccccc");

    await render(<ContinuityCenter client={client} peers={[phone]} continuity={snapshot({ screenShares: [{ ...share, state: "declined", reason: "Declined on the phone" }] })} initialTab="screen" onClose={() => {}} />);
    expect(container.textContent).toContain("Pixel 9 declined: Declined on the phone");
    expect(frameListeners.size).toBe(0); // unsubscribed
  });

  it("asks for sound when the phone can send it and follows a cast started on the phone", async () => {
    const { client } = fakeClient();
    const audioSubs: string[] = [];
    const withAudio = { ...client, subscribeScreenAudio: vi.fn((id: string) => { audioSubs.push(id); return () => {}; }) };
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain() { return { gain: { value: 1 }, connect() {} }; }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const feats = { [PHONE]: ["contacts.receive", "screen.source", "screen.audio"] as const, [MAC]: ["contacts.receive", "screen.source"] as const };
    const snap = snapshot({ peerFeatures: feats as never });
    await render(<ContinuityCenter client={withAudio} peers={[mac, phone]} continuity={snap} initialTab="screen" onClose={() => {}} />);
    // The phone just started casting: it takes focus over the default device.
    const cast: ScreenShareView = { sessionId: "dddddddddddddddd", peerId: PHONE, peerName: "Pixel 9", role: "viewer", state: "requesting", width: 0, height: 0, maxWidth: 1280, maxFps: 15, frames: 0, fps: 0, kbps: 0, startedAt: 1, updatedAt: 1, invited: true, audio: true };
    await render(<ContinuityCenter client={withAudio} peers={[mac, phone]} continuity={snapshot({ peerFeatures: feats as never, screenShares: [cast] })} initialTab="screen" focusPeerId={PHONE} onClose={() => {}} />);
    expect((container.querySelector('select[aria-label="Device"]') as HTMLSelectElement).value).toBe(PHONE);
    expect(container.textContent).toContain("Pixel 9 is starting to cast");
    expect(audioSubs).toEqual(["dddddddddddddddd"]);
    await render(<ContinuityCenter client={withAudio} peers={[mac, phone]} continuity={snapshot({ peerFeatures: feats as never, screenShares: [{ ...cast, state: "active", fps: 30, kbps: 900, reason: "Protected video shows black — the app blocks capture." }] })} initialTab="screen" focusPeerId={PHONE} onClose={() => {}} />);
    expect(container.textContent).toContain("Casting from Pixel 9");
    expect(container.querySelector(".screen-notice")?.textContent).toContain("Protected video");
    act(() => button("Mute").click());
    expect(button("Unmute").getAttribute("aria-pressed")).toBe("true");

    // Starting from the computer offers "Include sound" and asks for it.
    await render(<ContinuityCenter client={withAudio} peers={[mac, phone]} continuity={snapshot({ peerFeatures: feats as never, screenShares: [{ ...cast, state: "stopped" }] })} initialTab="screen" focusPeerId={PHONE} onClose={() => {}} />);
    expect(container.textContent).toContain("Include sound");
    expect(container.textContent).toContain("DRM-protected");
    act(() => button(/View Pixel 9 screen/).click());
    expect(withAudio.requestScreenShare).toHaveBeenCalledWith(PHONE, { maxWidth: 1280, maxFps: 15, audio: true });
    vi.unstubAllGlobals();
  });
});

describe("ContinuityAlerts", () => {
  it("shows an incoming call banner with answer and decline", async () => {
    const { client } = fakeClient();
    const onOpenCalls = vi.fn();
    await render(<ContinuityAlerts client={client} continuity={snapshot({ calls: [ringing] })} onOpenCalls={onOpenCalls} startCapture={vi.fn()} />);
    const banner = container.querySelector('[aria-label="Incoming call from Mum"]')!;
    expect(banner.textContent).toContain("Incoming call on Pixel 9");
    await act(async () => { button("Answer", banner).click(); });
    expect(client.answerCall).toHaveBeenCalledWith(PHONE, ringing.callId);
    expect(onOpenCalls).toHaveBeenCalled();
    await act(async () => { button("Decline", banner).click(); });
    expect(client.rejectCall).toHaveBeenCalledWith(PHONE, ringing.callId);
  });

  it("asks before sharing this computer's screen and starts the picker on Allow", async () => {
    const { client } = fakeClient();
    const source = { capture: vi.fn(), stop: vi.fn() } as unknown as ScreenFrameSource;
    const startCapture = vi.fn(async () => source);
    const request = { sessionId: "eeeeeeeeeeeeeeee", peerId: MAC, peerName: "Studio Mac", maxWidth: 1280, maxFps: 15, requestedAt: 1 };
    await render(<ContinuityAlerts client={client} continuity={snapshot({ screenRequests: [request] })} onOpenCalls={() => {}} startCapture={startCapture} />);
    expect(container.textContent).toContain("Studio Mac wants to view your screen");
    await act(async () => { button("Choose screen…").click(); });
    expect(startCapture).toHaveBeenCalledWith(15);
    expect(client.acceptScreenShare).toHaveBeenCalledWith(request.sessionId, source);
  });

  it("declines when the user cancels the browser picker", async () => {
    const { client } = fakeClient();
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const request = { sessionId: "eeeeeeeeeeeeeeee", peerId: MAC, peerName: "Studio Mac", maxWidth: 1280, maxFps: 15, requestedAt: 1 };
    await render(<ContinuityAlerts client={client} continuity={snapshot({ screenRequests: [request] })} onOpenCalls={() => {}} startCapture={vi.fn(async () => { throw denied; })} />);
    await act(async () => { button("Choose screen…").click(); });
    expect(client.declineScreenShare).toHaveBeenCalledWith(request.sessionId);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Screen sharing was cancelled.");
  });

  it("keeps a stop bar visible while sharing and renders nothing when idle", async () => {
    const { client } = fakeClient();
    const sharing: ScreenShareView = { sessionId: "ffffffffffffffff", peerId: MAC, peerName: "Studio Mac", role: "source", state: "active", width: 1280, height: 800, maxWidth: 1280, maxFps: 15, frames: 9, fps: 15, kbps: 900, startedAt: 1, updatedAt: 1 };
    await render(<ContinuityAlerts client={client} continuity={snapshot({ screenShares: [sharing] })} onOpenCalls={() => {}} startCapture={vi.fn()} />);
    expect(container.textContent).toContain("Sharing your screen with Studio Mac");
    act(() => button("Stop sharing").click());
    expect(client.stopScreenShare).toHaveBeenCalledWith(sharing.sessionId);
    await render(<ContinuityAlerts client={client} continuity={undefined} onOpenCalls={() => {}} startCapture={vi.fn()} />);
    expect(container.querySelector(".continuity-alerts")).toBeNull();
  });
});

describe("screen capture source", () => {
  it("fits the longer edge and keeps even dimensions", () => {
    expect(fitWithin(2560, 1600, 1280)).toEqual({ width: 1280, height: 800 });
    expect(fitWithin(1080, 2400, 1280)).toEqual({ width: 576, height: 1280 });
    expect(fitWithin(801, 601, 1920)).toEqual({ width: 802, height: 602 });
    expect(fitWithin(0, 600, 1280)).toEqual({ width: 0, height: 0 });
  });

  it("pulls scaled JPEG frames on demand and reports the end of capture", async () => {
    let endedCb: (() => void) | undefined;
    const trackStop = vi.fn();
    const stream = {
      getVideoTracks: () => [{ stop: trackStop, addEventListener: (_: "ended", cb: () => void) => { endedCb = cb; } }],
      getTracks: () => [{ stop: trackStop }],
    };
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (cb: (b: Blob | null) => void, typeName: string, quality: number) => {
        expect(typeName).toBe("image/jpeg");
        expect(quality).toBe(0.6);
        cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]));
      },
    };
    const video = { videoWidth: 2880, videoHeight: 1800, srcObject: null as unknown, muted: true, play: async () => {} };
    const source = createStreamScreenSource(stream, { video, canvas });
    expect(video.srcObject).toBe(stream);
    const frame = await source.capture({ maxWidth: 1440, quality: 0.6 });
    expect(frame).toEqual({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 1440, height: 900 });
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1440, 900);
    expect(canvas.width).toBe(1440);

    const ended = vi.fn();
    source.onEnded?.(ended);
    endedCb?.(); // user clicked the browser's "Stop sharing"
    expect(ended).toHaveBeenCalledTimes(1);
    expect(await source.capture({ maxWidth: 1440, quality: 0.6 })).toBeNull();
    source.stop();
    expect(trackStop).not.toHaveBeenCalled(); // already ended by the browser
  });

  it("stop() releases the tracks", () => {
    const trackStop = vi.fn();
    const stream = { getVideoTracks: () => [{ stop: trackStop, addEventListener: () => {} }], getTracks: () => [{ stop: trackStop }] };
    const video = { videoWidth: 0, videoHeight: 0, srcObject: null as unknown, muted: true, play: async () => {} };
    const source = createStreamScreenSource(stream, { video, canvas: { width: 0, height: 0, getContext: () => null, toBlob: () => {} } });
    source.stop();
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
  });
});
