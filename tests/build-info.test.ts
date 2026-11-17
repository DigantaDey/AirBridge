// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStaleUi, reloadForServerVersion } from '../src/client/engine/buildInfo.js';
import { canRestartLocalService, isThisComputerPage, requestLocalServiceRestart } from '../src/client/engine/desktopShell.js';

describe('stale UI detection', () => {
  it('flags a page whose build differs from the running service', () => {
    expect(isStaleUi('0.0.5', '0.0.4')).toBe(true);
    expect(isStaleUi('0.0.4', '0.0.4')).toBe(false);
  });

  it('never forces a reload for dev builds or unknown versions', () => {
    expect(isStaleUi('dev', '0.0.4')).toBe(false);
    expect(isStaleUi('0.0.4', 'dev')).toBe(false);
    expect(isStaleUi(undefined, '0.0.4')).toBe(false);
    expect(isStaleUi(null, '0.0.4')).toBe(false);
    expect(isStaleUi('0.0.4', undefined)).toBe(false);
  });

  it('reloads at most once per server version (no reload loop)', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      sessionStorage.clear();
      expect(reloadForServerVersion('0.0.5')).toBe(true);
      expect(reloadForServerVersion('0.0.5')).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadForServerVersion('0.0.6')).toBe(true);
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('macOS app shell bridge', () => {
  afterEach(() => {
    delete (window as unknown as { webkit?: unknown }).webkit;
  });

  it('knows the page is served by this computer', () => {
    // jsdom default URL is http://localhost:3000/
    expect(isThisComputerPage()).toBe(true);
  });

  it('offers a restart only inside the macOS app, and posts the request to it', () => {
    expect(canRestartLocalService()).toBe(false);
    expect(requestLocalServiceRestart()).toBe(false);
    const postMessage = vi.fn();
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { airbridgeShell: { postMessage } } };
    expect(canRestartLocalService()).toBe(true);
    expect(requestLocalServiceRestart()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ action: 'restart-server' });
  });
});
