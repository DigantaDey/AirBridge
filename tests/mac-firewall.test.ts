// @vitest-environment node
/**
 * macOS Application Firewall reporting. A phone on the Mac's own hotspot whose
 * TCP connect times out is, in practice, the firewall dropping the SYN — and
 * every ad-hoc signed AirBridge update is a new, unapproved app to it. The
 * phone can't tell that from a wrong network, so the Mac reports its state:
 *  - tolerant parsing of `socketfilterfw` output across macOS versions
 *  - welcome / `network` / /api/health carry it; a change is pushed live
 *  - the pairing panel shows a blocking/warning notice with the unblock command
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  firewallMayBlock,
  parseAppBlocked,
  parseFirewall,
  parseGlobalState,
  readMacFirewall,
} from '../src/server/macFirewall.js';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import { firewallNotice } from '../src/client/components/PairingDock.js';
import type { HostFirewallStatus } from '../src/shared/protocol.js';

const APP = '/usr/local/bin/airbridge';

describe('socketfilterfw parsing', () => {
  it('reads the global state across wordings', () => {
    expect(parseGlobalState('Firewall is enabled. (State = 1)')).toEqual({ enabled: true, blockAllFromState: false });
    expect(parseGlobalState('Firewall is disabled. (State = 0)')).toEqual({ enabled: false, blockAllFromState: false });
    expect(parseGlobalState('Firewall is blocking all non-essential incoming connections. (State = 2)')).toEqual({ enabled: true, blockAllFromState: true });
    expect(parseGlobalState('Firewall is enabled.')).toEqual({ enabled: true, blockAllFromState: false });
    expect(parseGlobalState(null).enabled).toBeNull();
    expect(parseGlobalState('garbage').enabled).toBeNull();
  });

  it('reads the per-app verdict', () => {
    expect(parseAppBlocked(`The application at ${APP} is blocked.`)).toBe('blocked');
    expect(parseAppBlocked(`The application at ${APP} is permitted.`)).toBe('allowed');
    expect(parseAppBlocked(`${APP} is not part of the firewall`)).toBe('not-listed');
    expect(parseAppBlocked('')).toBe('unknown');
    expect(parseAppBlocked(null)).toBe('unknown');
  });

  it('combines outputs; "Block all DISABLED!" is not block-all', () => {
    const base = { global: 'Firewall is enabled. (State = 1)', stealth: 'Stealth mode enabled', app: `${APP} is permitted` };
    expect(parseFirewall({ ...base, blockAll: 'Block all DISABLED!' }, APP)).toEqual({
      enabled: true, blockAll: false, stealth: true, app: 'allowed', appPath: APP,
    });
    expect(parseFirewall({ ...base, blockAll: 'Block all ENABLED!' }, APP)?.blockAll).toBe(true);
    expect(parseFirewall({ ...base, blockAll: 'Firewall has block all state set to enabled.' }, APP)?.blockAll).toBe(true);
    // Firewall off: nothing else matters.
    expect(parseFirewall({ ...base, global: 'Firewall is disabled. (State = 0)', blockAll: 'Block all ENABLED!' }, APP)).toMatchObject({
      enabled: false, blockAll: false, app: 'unknown',
    });
    // Unreadable global state → unknown → no claim at all.
    expect(parseFirewall({ ...base, global: null, blockAll: null }, APP)).toBeNull();
  });

  it('runs the probe only on macOS, with the binary path', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === '--getglobalstate') return 'Firewall is enabled. (State = 1)';
      if (args[0] === '--getappblocked') return `The application at ${args[1]} is blocked.`;
      return 'disabled';
    };
    expect(await readMacFirewall(APP, run, 'linux')).toBeNull();
    expect(calls).toEqual([]);
    const status = await readMacFirewall(APP, run, 'darwin');
    expect(status).toMatchObject({ enabled: true, blockAll: false, app: 'blocked', appPath: APP });
    expect(calls).toContainEqual(['--getappblocked', APP]);
    expect(firewallMayBlock(status)).toBe(true);
  });
});

describe('pairing panel notice', () => {
  const on = (over: Partial<HostFirewallStatus>): HostFirewallStatus => ({
    enabled: true, blockAll: false, stealth: false, app: 'unknown', appPath: APP, ...over,
  });

  it('is silent when the firewall is off or AirBridge is allowed', () => {
    expect(firewallNotice(null)).toBeNull();
    expect(firewallNotice(on({ enabled: false }))).toBeNull();
    expect(firewallNotice(on({ app: 'allowed' }))).toBeNull();
    expect(firewallMayBlock(on({ app: 'allowed' }))).toBe(false);
  });

  it('blocks loudly for block-all and a blocked app, with the unblock command', () => {
    const all = firewallNotice(on({ blockAll: true, app: 'allowed' }));
    expect(all?.severity).toBe('block');
    expect(all?.text).toMatch(/Block all incoming connections/);
    const app = firewallNotice(on({ app: 'blocked' }));
    expect(app?.severity).toBe('block');
    expect(app?.command).toBe(`sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "${APP}" --unblockapp "${APP}"`);
  });

  it('warns when a new build is not yet approved', () => {
    for (const app of ['not-listed', 'unknown'] as const) {
      const n = firewallNotice(on({ app }));
      expect(n?.severity).toBe('warn');
      expect(n?.text).toMatch(/each update needs approval/);
      expect(n?.command).toContain('--unblockapp');
    }
  });
});

describe('server reports the firewall state to clients', () => {
  let tmp: string;
  let server: AirBridgeServerInstance;
  let current: HostFirewallStatus | null = null;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-fw-'));
    current = { enabled: true, blockAll: false, stealth: true, app: 'not-listed', appPath: APP };
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      https: false,
      tlsDir: path.join(tmp, 'certs'),
      hostClipboard: false,
      readFirewall: async () => current,
    });
    await server.refreshFirewall();
  });

  afterAll(async () => {
    await server?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('includes it in welcome and pushes a network update when it changes', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    ws.send(JSON.stringify({
      type: 'hello',
      device: { name: 'Mac UI', platform: 'macos', model: 'MacBook', formFactor: 'desktop', publicKey: ecdh.getPublicKey().toString('base64url') },
      visibility: 'nearby',
    }));
    const next = async (type: string) => {
      for (let i = 0; i < 300; i++) {
        const index = messages.findIndex((m) => m.type === type);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${type}`);
    };
    const welcome = await next('welcome');
    expect(welcome.hostFirewall).toMatchObject({ enabled: true, app: 'not-listed' });

    // User allows AirBridge in System Settings → pushed without reconnecting.
    current = { ...current!, app: 'allowed' };
    await server.refreshFirewall();
    const update = await next('network');
    expect(update.hostFirewall).toMatchObject({ app: 'allowed' });

    // No change → no extra broadcast.
    await server.refreshFirewall();
    await new Promise((r) => setTimeout(r, 50));
    expect(messages.filter((m) => m.type === 'network')).toHaveLength(0);
    ws.close();
  });
});
