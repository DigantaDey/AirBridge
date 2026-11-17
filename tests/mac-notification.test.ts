// @vitest-environment node
/**
 * macOS notifications go to the AirBridge app over the loopback shell channel
 * (UNUserNotificationCenter there), else osascript. Nothing is compiled at
 * runtime — a synchronous swiftc helper build once froze the service long
 * enough for its supervisor to restart it in a loop.
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postMacOsNotification } from '../src/server/macNotification.js';
import { addShellSubscriber, resetShellSubscribersForTests } from '../src/server/shellEvents.js';

function fakeResponse() {
  const chunks: string[] = [];
  const listeners: Record<string, () => void> = {};
  const res = {
    status: () => res,
    setHeader: () => res,
    flushHeaders: () => {},
    write: (c: string) => { chunks.push(c); return true; },
    on: (ev: string, fn: () => void) => { listeners[ev] = fn; return res; },
  };
  return { res: res as never, chunks, close: () => listeners.close?.() };
}

afterEach(() => resetShellSubscribersForTests());

describe('macOS notifications', () => {
  it('are delivered to the AirBridge app when it is subscribed', () => {
    const app = fakeResponse();
    addShellSubscriber(app.res, ['notification'], { type: 'hello', version: '1.0.0', pid: 1 });
    const fallback = vi.fn();
    expect(postMacOsNotification('Hello', 'From phone', 'Messages', 'darwin', fallback)).toBe('shell');
    expect(fallback).not.toHaveBeenCalled();
    const event = app.chunks.find((c) => c.startsWith('event: notification'))!;
    expect(JSON.parse(event.split('data: ')[1]!)).toEqual({ type: 'notification', title: 'Hello', body: 'From phone', appName: 'Messages' });
  });

  it('fall back to osascript when no app is listening (or it disconnected)', () => {
    const app = fakeResponse();
    addShellSubscriber(app.res, ['notification'], { type: 'hello', version: '1.0.0', pid: 1 });
    app.close();
    const fallback = vi.fn();
    expect(postMacOsNotification('Hello', 'Body', 'Messages', 'darwin', fallback)).toBe('osascript');
    expect(fallback).toHaveBeenCalledWith('Messages: Hello', 'Body');
  });

  it('skip shells that did not ask for notifications, and other platforms', () => {
    const lifecycleOnly = fakeResponse();
    addShellSubscriber(lifecycleOnly.res, ['lifecycle'], { type: 'hello', version: '1.0.0', pid: 1 });
    const fallback = vi.fn();
    expect(postMacOsNotification('T', 'B', undefined, 'darwin', fallback)).toBe('osascript');
    expect(postMacOsNotification('T', 'B', undefined, 'linux', fallback)).toBe('skipped');
    expect(postMacOsNotification('  ', ' ', undefined, 'darwin', fallback)).toBe('skipped');
  });

  it('never compiles or spawns helpers synchronously', () => {
    const source = fs.readFileSync('src/server/macNotification.ts', 'utf8');
    expect(source).not.toMatch(/execFileSync|spawnSync|execSync|swiftc/);
  });
});
