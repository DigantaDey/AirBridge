import { execFile } from 'node:child_process';
import type { HostFirewallStatus } from '../shared/protocol.js';

/**
 * macOS Application Firewall probe.
 *
 * A phone on the Mac's own subnet (e.g. the Mac joined the phone's hotspot)
 * whose TCP SYN times out is, in practice, almost always the Application
 * Firewall dropping it: "Block all incoming connections", or the AirBridge
 * binary being blocked / never approved. Release binaries are ad-hoc signed,
 * so every update is a *new* app to the firewall and loses earlier approval.
 * From the phone this is indistinguishable from a wrong network, so the Mac
 * reports its own state and the pairing panel says exactly what to change.
 *
 * `socketfilterfw --get*` works without root. Output wording differs between
 * macOS releases, so parsing is deliberately tolerant and anything unknown
 * stays `null` (the UI then shows nothing rather than a wrong claim).
 */

export const SOCKETFILTERFW = '/usr/libexec/ApplicationFirewall/socketfilterfw';

const ON = /\b(enabled|on)\b/i;
const OFF = /\b(disabled|off)\b/i;

function onOff(text: string | null): boolean | null {
  if (!text) return null;
  if (OFF.test(text)) return false;
  if (ON.test(text)) return true;
  return null;
}

/** `--getglobalstate`: "Firewall is enabled. (State = 1)"; State 2 = block all. */
export function parseGlobalState(text: string | null): { enabled: boolean | null; blockAllFromState: boolean } {
  if (!text) return { enabled: null, blockAllFromState: false };
  const state = /State\s*=\s*(\d)/i.exec(text)?.[1];
  if (state === '0') return { enabled: false, blockAllFromState: false };
  if (state === '1') return { enabled: true, blockAllFromState: false };
  if (state === '2') return { enabled: true, blockAllFromState: true };
  if (/blocking all/i.test(text)) return { enabled: true, blockAllFromState: true };
  return { enabled: onOff(text), blockAllFromState: false };
}

/** `--getappblocked <path>`: "... is blocked." / "... is permitted." / not listed. */
export function parseAppBlocked(text: string | null): HostFirewallStatus['app'] {
  if (!text) return 'unknown';
  const t = text.toLowerCase();
  if (/not (part of|found|in)|no such|isn't|is not (in|part)/.test(t)) return 'not-listed';
  if (/\bblock(ed|ing)?\b/.test(t) && !/\bunblock/.test(t)) return 'blocked';
  if (/\b(permitted|allowed|allow incoming|unblocked)\b/.test(t)) return 'allowed';
  return 'unknown';
}

export interface FirewallOutputs {
  global: string | null;
  blockAll: string | null;
  stealth: string | null;
  app: string | null;
}

export function parseFirewall(out: FirewallOutputs, appPath: string): HostFirewallStatus | null {
  const { enabled, blockAllFromState } = parseGlobalState(out.global);
  if (enabled === null) return null;
  const blockAll = blockAllFromState || onOff(out.blockAll) === true;
  return {
    enabled,
    blockAll: enabled && blockAll,
    stealth: enabled && onOff(out.stealth) === true,
    app: enabled ? parseAppBlocked(out.app) : 'unknown',
    appPath,
  };
}

/** True when the state can stop a phone from reaching AirBridge. */
export function firewallMayBlock(status: HostFirewallStatus | null | undefined): boolean {
  return !!status && status.enabled && (status.blockAll || status.app === 'blocked' || status.app === 'not-listed' || status.app === 'unknown');
}

type Runner = (args: string[]) => Promise<string | null>;

const defaultRunner: Runner = (args) =>
  new Promise((resolve) => {
    execFile(SOCKETFILTERFW, args, { timeout: 4000 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
      resolve(err && !text ? null : text || null);
    });
  });

export async function readMacFirewall(
  appPath: string = process.execPath,
  run: Runner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<HostFirewallStatus | null> {
  if (platform !== 'darwin') return null;
  const [global, blockAll, stealth, app] = await Promise.all([
    run(['--getglobalstate']),
    run(['--getblockall']),
    run(['--getstealthmode']),
    run(['--getappblocked', appPath]),
  ]);
  return parseFirewall({ global, blockAll, stealth, app }, appPath);
}

export function firewallKey(status: HostFirewallStatus | null): string {
  return status ? `${status.enabled}|${status.blockAll}|${status.stealth}|${status.app}` : 'none';
}
