import net from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';

/**
 * Deterministic selection of the addresses a *peer* (phone) could plausibly
 * use to reach this computer.
 *
 * Background: a laptop routinely has several active interfaces — Wi-Fi, a
 * USB/Ethernet dock, a phone's USB/Bluetooth tether, VPN tunnels, Docker or
 * VM bridges. The computer cannot know which of them faces the phone. The old
 * code put whichever address happened to sort first into the QR code, so a
 * MacBook attached to both a campus LAN (en0) and a phone hotspot (en7)
 * advertised the campus address; the phone had no route to it and its kernel
 * sent the SYN out over cellular (source 192.0.0.2, the 464XLAT CLAT address),
 * where it timed out.
 *
 * Rules:
 *  - IPv4 only. IPv6 link-local needs a zone id that cannot travel in a QR,
 *    and the TLS certificate / QR / mDNS stay consistent on one family.
 *  - Never loopback, link-local (169.254/16), unspecified, multicast or
 *    broadcast addresses.
 *  - Never virtual/tunnel interfaces (VPN utun/tun/wg/ipsec/ppp, Tailscale,
 *    ZeroTier, Docker/Podman/k8s bridges, VM host-only networks, AWDL/LLW):
 *    a phone on the LAN can never reach those addresses.
 *  - Every remaining candidate is returned (not just the first), ranked by a
 *    stable key that does not depend on `os.networkInterfaces()` order:
 *    interface kind, then address scope (RFC 1918 private > CGNAT > public),
 *    then natural interface-name order, then numeric address.
 *
 * Callers advertise *all* candidates (QR `alt=` list, mDNS per interface,
 * certificate SANs) and let the phone pick the one on a network it is
 * actually attached to.
 */

export type LanInterfaceKind = 'wifi' | 'ethernet' | 'tether' | 'other';
export type LanAddressScope = 'private' | 'cgnat' | 'public';

export interface LanCandidate {
  address: string;
  /** OS interface name, e.g. `en0`, `wlan0`, `Wi-Fi`. */
  interface: string;
  kind: LanInterfaceKind;
  scope: LanAddressScope;
  /** Dotted netmask as reported by the OS. */
  netmask: string;
  /** Prefix length derived from the netmask (0 when unknown). */
  prefixLength: number;
}

export type InterfaceMap = Partial<Record<string, NetworkInterfaceInfo[] | undefined>>;

/** Interfaces that can never face a LAN peer. Matched case-insensitively against the whole name. */
const EXCLUDED_INTERFACE = new RegExp(
  [
    '^lo\\d*$',
    '^loopback',
    // VPN / tunnels (macOS utun, Linux tun/tap, WireGuard, IPsec, PPP, 6to4/gif).
    '^utun\\d*$', '^tun\\d*$', '^tap\\d*$', '^wg\\d*', '^ipsec', '^ppp\\d*$', '^gif\\d*$', '^stf\\d*$',
    '^tailscale', '^zt', '^nordlynx', '^proton', '^mullvad',
    // Apple peer-to-peer radios and bridges (Internet Sharing / VM NAT).
    '^awdl\\d*$', '^llw\\d*$', '^anpi\\d*$', '^ap\\d+$', '^bridge\\d*$',
    // Containers and VMs.
    '^docker', '^br-', '^veth', '^virbr', '^vmnet', '^vboxnet', '^vnic', '^vethernet', '^cni', '^flannel',
    '^cali', '^podman', '^lxc', '^lxd', '^kube', '^vmenet', '^isatap', '^teredo',
  ].join('|'),
  'i'
);

/** Exposed for diagnostics/tests. */
export function isVirtualInterfaceName(name: string): boolean {
  return EXCLUDED_INTERFACE.test(name.trim()) || /\b(virtual|virtualbox|vmware|host-only|hyper-v|vpn|pseudo|loopback|tap-windows|wintun)\b/i.test(name);
}

export function classifyInterface(name: string, wifiDevice?: string | null): LanInterfaceKind {
  const n = name.trim().toLowerCase();
  if (/^(wlan|wlp|wlx|wl\d|wifi|wi-fi|airport)/.test(n) || n.includes('wi-fi') || n.includes('wireless')) return 'wifi';
  if (wifiDevice !== undefined) {
    if (wifiDevice && n === wifiDevice.trim().toLowerCase()) return 'wifi';
  } else if (n === 'en0') {
    // Fallback when OS hardware port map isn't provided: on macOS laptops en0 is usually built-in Wi-Fi.
    return 'wifi';
  }
  if (/^(usb|rndis|bnep|ncm)/.test(n)) return 'tether';
  if (/^(eth|enp|eno|ens|enx|en\d|ethernet)/.test(n) || n.includes('ethernet')) return 'ethernet';
  return 'other';
}

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map((p) => Number.parseInt(p, 10));
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function inCidr(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

export function prefixLengthFromNetmask(netmask: string | undefined): number {
  if (!netmask || !net.isIPv4(netmask)) return 0;
  let value = ipv4ToInt(netmask);
  let bits = 0;
  while (value & 0x80000000) {
    bits++;
    value = (value << 1) >>> 0;
  }
  return bits;
}

/** Scope of a usable unicast IPv4 address, or null when it must never be advertised. */
export function ipv4Scope(address: string): LanAddressScope | null {
  if (!net.isIPv4(address)) return null;
  if (
    inCidr(address, '0.0.0.0', 8) ||
    inCidr(address, '127.0.0.0', 8) ||
    inCidr(address, '169.254.0.0', 16) ||
    inCidr(address, '224.0.0.0', 4) ||
    inCidr(address, '240.0.0.0', 4) ||
    // 192.0.0.0/24 holds the 464XLAT CLAT addresses (192.0.0.2 …): never a LAN address.
    inCidr(address, '192.0.0.0', 24) ||
    // 198.18/15 is used by proxy "fake-IP" TUN adapters, not real LANs.
    inCidr(address, '198.18.0.0', 15)
  ) {
    return null;
  }
  if (inCidr(address, '10.0.0.0', 8) || inCidr(address, '172.16.0.0', 12) || inCidr(address, '192.168.0.0', 16)) {
    return 'private';
  }
  if (inCidr(address, '100.64.0.0', 10)) return 'cgnat';
  return 'public';
}

const KIND_RANK: Record<LanInterfaceKind, number> = { wifi: 0, ethernet: 1, tether: 2, other: 3 };
const SCOPE_RANK: Record<LanAddressScope, number> = { private: 0, cgnat: 1, public: 2 };

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Pure selection over an `os.networkInterfaces()`-shaped map. */
export function selectLanCandidates(interfaces: InterfaceMap, opts?: { wifiDevice?: string | null }): LanCandidate[] {
  const byAddress = new Map<string, LanCandidate>();
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || isVirtualInterfaceName(name)) continue;
    for (const addr of addrs) {
      // Node < 18.4 reported family as the number 4.
      const family = String(addr.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (addr.internal) continue;
      const scope = ipv4Scope(addr.address);
      if (!scope) continue;
      const prefixLength = prefixLengthFromNetmask(addr.netmask);
      // A /32 has no on-link peers at all (point-to-point / tunnel style).
      if (prefixLength === 32) continue;
      const candidate: LanCandidate = {
        address: addr.address,
        interface: name,
        kind: classifyInterface(name, opts?.wifiDevice),
        scope,
        netmask: addr.netmask,
        prefixLength,
      };
      const existing = byAddress.get(addr.address);
      if (!existing || compareCandidates(candidate, existing) < 0) byAddress.set(addr.address, candidate);
    }
  }
  return [...byAddress.values()].sort(compareCandidates);
}

export function compareCandidates(a: LanCandidate, b: LanCandidate): number {
  return (
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
    naturalCompare(a.interface, b.interface) ||
    ipv4ToInt(a.address) - ipv4ToInt(b.address)
  );
}

/** Same network test used by tests and diagnostics. */
export function sameIpv4Subnet(a: string, b: string, prefixLength: number): boolean {
  if (!net.isIPv4(a) || !net.isIPv4(b)) return false;
  return inCidr(a, b, prefixLength);
}

export function candidateUrl(candidate: Pick<LanCandidate, 'address'>, port: number, protocol: 'http' | 'https'): string {
  return `${protocol}://${candidate.address}:${port}`;
}
