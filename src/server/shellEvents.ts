/**
 * Event channel from the service to the native desktop shell (the macOS app),
 * over Server-Sent Events on loopback: `GET /api/local/events`.
 *
 * The shell posts native notifications (UNUserNotificationCenter) and handles
 * lifecycle events (e.g. relaunch after an update). This replaces compiling
 * helper programs on the user's machine at runtime.
 *
 * Only processes on this machine can subscribe (loopback check in the route),
 * and the route requires an `X-AirBridge-Shell` header, which a web page on
 * another origin cannot send without a CORS preflight this server never grants.
 */
import type { Response } from 'express';

export type ShellEvent =
  | { type: 'notification'; title: string; body: string; appName?: string }
  | { type: 'update-installed'; version: string; relaunch: boolean }
  | { type: 'hello'; version: string; pid: number }
  /** A phone offers its hotspot; the shell may ask the user with native Allow / Not now actions. */
  | { type: 'handoff-request'; id: string; deviceName: string; ssid: string; expiresAt: string };

interface Subscriber {
  res: Response;
  capabilities: Set<string>;
}

const subscribers = new Set<Subscriber>();

export function shellSubscriberCount(capability?: string): number {
  if (!capability) return subscribers.size;
  let n = 0;
  for (const s of subscribers) if (s.capabilities.has(capability)) n++;
  return n;
}

/** Register an SSE response; returns an unsubscribe function. */
export function addShellSubscriber(res: Response, capabilities: string[], hello: ShellEvent): () => void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const sub: Subscriber = { res, capabilities: new Set(capabilities) };
  subscribers.add(sub);
  write(sub, hello);
  // Comment heartbeats keep idle connections open and let the shell detect a
  // dead service quickly.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 15_000);
  heartbeat.unref();
  const remove = () => {
    clearInterval(heartbeat);
    subscribers.delete(sub);
  };
  res.on('close', remove);
  return remove;
}

function write(sub: Subscriber, event: ShellEvent): boolean {
  try {
    sub.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch {
    subscribers.delete(sub);
    return false;
  }
}

/**
 * Deliver an event to every subscriber that declared `capability`.
 * Returns true if at least one shell received it.
 */
export function emitShellEvent(event: ShellEvent, capability: string = event.type): boolean {
  let delivered = false;
  for (const sub of [...subscribers]) {
    if (!sub.capabilities.has(capability)) continue;
    if (write(sub, event)) delivered = true;
  }
  return delivered;
}

/** Tests: drop all subscribers. */
export function resetShellSubscribersForTests(): void {
  subscribers.clear();
}
