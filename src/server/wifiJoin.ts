/**
 * Joins (and later leaves) a phone's hotspot with the operating system's own
 * Wi-Fi tools. No admin rights, no extra software:
 *
 *   macOS    networksetup -setairportnetwork <device> <ssid> <password>
 *   Linux    nmcli device wifi connect <ssid> password <password> (NetworkManager)
 *   Windows  netsh wlan add profile (temporary XML, deleted right away) + connect
 *
 * After leaving, the previous network is rejoined when the system reports it;
 * otherwise the OS falls back to its preferred networks by itself. Passwords
 * never appear in logs or errors.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HotspotSecurity = 'wpa2' | 'wpa3' | 'wpa2-wpa3';

export interface WifiCredentials {
  ssid: string;
  psk: string;
  security: HotspotSecurity;
}

export interface JoinResult {
  device: string;
  /** IPv4 address received on the hotspot (null if not observed in time). */
  address: string | null;
  /** Network we were on before (rejoined on leave), if the OS told us. */
  previous: string | null;
}

export interface WifiJoiner {
  readonly platform: NodeJS.Platform;
  /** Null when joining is possible; otherwise why not (shown to the user). */
  unsupportedReason(): Promise<string | null>;
  join(credentials: WifiCredentials): Promise<JoinResult>;
  /** Leaves the hotspot; returns the network rejoined, if any. */
  leave(ssid: string): Promise<string | null>;
}

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], timeoutMs?: number) => Promise<ExecResult>;
export type InterfaceReader = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export const defaultExec: Exec = (cmd, args, timeoutMs = 45_000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 127) : 0;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/** Never let a password reach a log line or an error shown in the UI. */
export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('••••') : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── parsers ─────────────────────────────

/** `networksetup -listallhardwareports` → Wi-Fi device (en0 …). */
export function parseMacWifiDevice(text: string): string | null {
  const m = /Hardware Port:\s*(?:Wi-Fi|AirPort)\s*\r?\nDevice:\s*(\S+)/i.exec(text);
  return m ? m[1]! : null;
}

/** `networksetup -getairportnetwork en0` → SSID (null when not associated or hidden by privacy settings). */
export function parseMacCurrentNetwork(text: string): string | null {
  const m = /Current (?:Wi-Fi|AirPort) Network:\s*(.+)\s*$/im.exec(text);
  const ssid = m?.[1]?.trim();
  return ssid && ssid !== '<redacted>' ? ssid : null;
}

/** networksetup reports join failures on stdout with exit status 0. */
export function macJoinFailure(output: string): string | null {
  const text = output.trim();
  if (!text) return null;
  if (/could not find network/i.test(text)) return 'not-found';
  if (/failed|error|could not|-3900|-3905/i.test(text)) return text.split('\n')[0]!.slice(0, 200);
  return null;
}

/** `nmcli -t -f DEVICE,TYPE,STATE device` → first Wi-Fi device. */
export function parseNmcliWifiDevice(text: string): string | null {
  for (const line of text.split('\n')) {
    const [device, type, state] = line.split(':');
    if (type === 'wifi' && device && state !== 'unavailable' && !/p2p/.test(device)) return device;
  }
  return null;
}

/** `nmcli -t -f NAME,TYPE,DEVICE connection show --active` → active Wi-Fi connection on `device`. */
export function parseNmcliActiveConnection(text: string, device: string): string | null {
  for (const line of text.split('\n')) {
    // NAME may contain escaped colons (\:).
    const parts = line.split(/(?<!\\):/).map((p) => p.replace(/\\:/g, ':'));
    if (parts.length >= 3 && parts[parts.length - 1] === device && /wireless|wifi/.test(parts[parts.length - 2]!)) {
      return parts.slice(0, parts.length - 2).join(':');
    }
  }
  return null;
}

/** `netsh wlan show interfaces` → { name, ssid } of the first wireless interface. */
export function parseNetshInterfaces(text: string): { name: string | null; ssid: string | null } {
  const name = /^\s*Name\s*:\s*(.+?)\s*$/m.exec(text)?.[1] ?? null;
  const ssid = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(text)?.[1] ?? null;
  return { name, ssid };
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Windows WLAN profile; connectionMode manual so it never auto-joins later. */
export function windowsProfileXml(c: WifiCredentials): string {
  const hex = Buffer.from(c.ssid, 'utf8').toString('hex').toUpperCase();
  const auth = c.security === 'wpa3' ? 'WPA3SAE' : 'WPA2PSK';
  const keyType = /^[0-9a-fA-F]{64}$/.test(c.psk) ? 'networkKey' : 'passPhrase';
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xmlEscape(c.ssid)}</name>
  <SSIDConfig><SSID><hex>${hex}</hex><name>${xmlEscape(c.ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>${auth}</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>${keyType}</keyType><protected>false</protected><keyMaterial>${xmlEscape(c.psk)}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>
`;
}

/** First usable IPv4 on `device` (not link-local). */
export function ipv4On(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, device: string): string | null {
  for (const info of interfaces[device] ?? []) {
    if ((info.family === 'IPv4' || (info.family as unknown) === 4) && !info.internal && !info.address.startsWith('169.254.')) return info.address;
  }
  return null;
}

// ───────────────────────────── joiner ─────────────────────────────

export const NM_CONNECTION_NAME = 'AirBridge handoff';

export interface JoinerDeps {
  exec?: Exec;
  interfaces?: InterfaceReader;
  /** Time to wait for an address after associating. */
  addressTimeoutMs?: number;
  /** Delay between "network not found" retries (a fresh hotspot can take a few seconds to show up). */
  retryDelayMs?: number;
  tmpDir?: string;
}

export function createWifiJoiner(platform: NodeJS.Platform = process.platform, deps: JoinerDeps = {}): WifiJoiner {
  const exec = deps.exec ?? defaultExec;
  const interfaces = deps.interfaces ?? os.networkInterfaces;
  const addressTimeoutMs = deps.addressTimeoutMs ?? 20_000;
  const retryDelayMs = deps.retryDelayMs ?? 2_500;
  let state: { device: string; previous: string | null; ssid: string } | null = null;

  const waitForAddress = async (device: string, before: string | null): Promise<string | null> => {
    const deadline = Date.now() + addressTimeoutMs;
    for (;;) {
      const addr = ipv4On(interfaces(), device);
      if (addr && addr !== before) return addr;
      if (Date.now() >= deadline) return addr;
      await sleep(Math.min(500, addressTimeoutMs));
    }
  };

  const fail = (message: string, c?: WifiCredentials): never => {
    throw new Error(c ? redactSecret(message, c.psk) : message);
  };

  if (platform === 'darwin') {
    const device = async () => parseMacWifiDevice((await exec('networksetup', ['-listallhardwareports'], 10_000)).stdout);
    return {
      platform,
      async unsupportedReason() {
        return (await device()) ? null : 'This Mac has no Wi-Fi interface.';
      },
      async join(c) {
        const dev = (await device()) ?? fail('This Mac has no Wi-Fi interface.');
        const previous = parseMacCurrentNetwork((await exec('networksetup', ['-getairportnetwork', dev], 10_000)).stdout);
        const before = ipv4On(interfaces(), dev);
        // Wi-Fi may be switched off.
        await exec('networksetup', ['-setairportpower', dev, 'on'], 10_000);
        let lastError = '';
        for (let attempt = 0; attempt < 4; attempt++) {
          const r = await exec('networksetup', ['-setairportnetwork', dev, c.ssid, c.psk], 45_000);
          const problem = r.code !== 0 ? (r.stderr || r.stdout || `exit ${r.code}`) : macJoinFailure(`${r.stdout}\n${r.stderr}`);
          if (!problem) {
            state = { device: dev, previous, ssid: c.ssid };
            return { device: dev, address: await waitForAddress(dev, before), previous };
          }
          lastError = problem === 'not-found' ? `The hotspot “${c.ssid}” is not visible to this Mac yet.` : problem;
          if (problem !== 'not-found') break;
          await sleep(retryDelayMs);
        }
        return fail(`Could not join “${c.ssid}”: ${lastError}`, c);
      },
      async leave(ssid) {
        const s = state;
        state = null;
        if (!s) return null;
        // Do not keep the throwaway hotspot as a preferred network (may need
        // admin rights depending on settings; best effort).
        await exec('networksetup', ['-removepreferredwirelessnetwork', s.device, ssid], 10_000);
        if (s.previous && s.previous !== ssid) {
          const r = await exec('networksetup', ['-setairportnetwork', s.device, s.previous], 45_000);
          if (r.code === 0 && !macJoinFailure(r.stdout)) return s.previous;
        }
        // Let macOS pick its preferred network again.
        await exec('networksetup', ['-setairportpower', s.device, 'off'], 10_000);
        await exec('networksetup', ['-setairportpower', s.device, 'on'], 10_000);
        return null;
      },
    };
  }

  if (platform === 'linux') {
    const device = async () => {
      const r = await exec('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device'], 10_000);
      return r.code === 0 ? parseNmcliWifiDevice(r.stdout) : null;
    };
    return {
      platform,
      async unsupportedReason() {
        const r = await exec('nmcli', ['--version'], 5_000);
        if (r.code !== 0) return 'NetworkManager (nmcli) is not available; join the hotspot from your Wi-Fi menu instead.';
        return (await device()) ? null : 'No Wi-Fi device is available.';
      },
      async join(c) {
        const dev = (await device()) ?? fail('No Wi-Fi device is available (or NetworkManager is not running).');
        const active = await exec('nmcli', ['-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active'], 10_000);
        const previous = active.code === 0 ? parseNmcliActiveConnection(active.stdout, dev) : null;
        const before = ipv4On(interfaces(), dev);
        await exec('nmcli', ['radio', 'wifi', 'on'], 10_000);
        await exec('nmcli', ['connection', 'delete', NM_CONNECTION_NAME], 10_000); // leftovers
        let lastError = '';
        for (let attempt = 0; attempt < 4; attempt++) {
          const r = await exec('nmcli', ['--wait', '40', 'device', 'wifi', 'connect', c.ssid, 'password', c.psk, 'ifname', dev, 'name', NM_CONNECTION_NAME], 50_000);
          if (r.code === 0) {
            await exec('nmcli', ['connection', 'modify', NM_CONNECTION_NAME, 'connection.autoconnect', 'no'], 10_000);
            state = { device: dev, previous: previous === NM_CONNECTION_NAME ? null : previous, ssid: c.ssid };
            return { device: dev, address: await waitForAddress(dev, before), previous: state.previous };
          }
          lastError = (r.stderr || r.stdout).trim().split('\n')[0] ?? `exit ${r.code}`;
          if (!/no network with ssid|not found/i.test(lastError)) break;
          await exec('nmcli', ['device', 'wifi', 'rescan', 'ifname', dev], 15_000);
          await sleep(retryDelayMs);
        }
        await exec('nmcli', ['connection', 'delete', NM_CONNECTION_NAME], 10_000);
        return fail(`Could not join “${c.ssid}”: ${lastError}`, c);
      },
      async leave() {
        const s = state;
        state = null;
        await exec('nmcli', ['connection', 'delete', NM_CONNECTION_NAME], 15_000);
        if (s?.previous) {
          const r = await exec('nmcli', ['--wait', '30', 'connection', 'up', 'id', s.previous], 40_000);
          if (r.code === 0) return s.previous;
        }
        return null;
      },
    };
  }

  if (platform === 'win32') {
    const iface = async () => parseNetshInterfaces((await exec('netsh', ['wlan', 'show', 'interfaces'], 10_000)).stdout);
    return {
      platform,
      async unsupportedReason() {
        return (await iface()).name ? null : 'No Wi-Fi adapter is available.';
      },
      async join(c) {
        const { name, ssid: previous } = await iface();
        if (!name) return fail('No Wi-Fi adapter is available.');
        const before = ipv4On(interfaces(), name);
        const dir = fs.mkdtempSync(path.join(deps.tmpDir ?? os.tmpdir(), 'airbridge-wlan-'));
        const file = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.xml`);
        try {
          fs.writeFileSync(file, windowsProfileXml(c), { mode: 0o600 });
          const add = await exec('netsh', ['wlan', 'add', 'profile', `filename=${file}`, 'user=current'], 15_000);
          if (add.code !== 0) fail(`Could not add the Wi-Fi profile: ${(add.stdout || add.stderr).trim().split('\n')[0]}`, c);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        let lastError = '';
        for (let attempt = 0; attempt < 4; attempt++) {
          const r = await exec('netsh', ['wlan', 'connect', `name=${c.ssid}`, `ssid=${c.ssid}`, `interface=${name}`], 20_000);
          if (r.code === 0) {
            const address = await waitForAddress(name, before);
            if (address) {
              state = { device: name, previous: previous && previous !== c.ssid ? previous : null, ssid: c.ssid };
              return { device: name, address, previous: state.previous };
            }
            lastError = 'connected but no address was assigned';
          } else {
            lastError = (r.stdout || r.stderr).trim().split('\n')[0] ?? `exit ${r.code}`;
          }
          await sleep(retryDelayMs);
        }
        await exec('netsh', ['wlan', 'delete', 'profile', `name=${c.ssid}`], 10_000);
        return fail(`Could not join “${c.ssid}”: ${lastError}`, c);
      },
      async leave(ssid) {
        const s = state;
        state = null;
        await exec('netsh', ['wlan', 'delete', 'profile', `name=${ssid}`], 10_000);
        if (s?.previous) {
          const r = await exec('netsh', ['wlan', 'connect', `name=${s.previous}`, `interface=${s.device}`], 20_000);
          if (r.code === 0) return s.previous;
        }
        return null;
      },
    };
  }

  return {
    platform,
    async unsupportedReason() { return 'Joining Wi-Fi automatically is not supported on this system; join the hotspot from your Wi-Fi menu.'; },
    async join() { throw new Error('Joining Wi-Fi automatically is not supported on this system.'); },
    async leave() { return null; },
  };
}
