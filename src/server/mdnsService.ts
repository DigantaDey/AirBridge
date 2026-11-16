import dgram from 'node:dgram';
import os from 'node:os';
import { selectLanCandidates, type InterfaceMap, type LanCandidate } from './lanAddresses.js';

const MDNS_MULTICAST_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
export const MDNS_SERVICE_TYPE = '_airbridge._tcp.local';

/**
 * Every address a LAN peer could plausibly reach this machine on, ranked
 * deterministically (see lanAddresses.ts). The QR code, the mDNS records and
 * the TLS certificate SANs are all derived from this one list.
 */
export function getLanCandidates(interfaces: InterfaceMap = os.networkInterfaces()): LanCandidate[] {
  return selectLanCandidates(interfaces);
}

/** Addresses only, in the same order as {@link getLanCandidates}. */
export function getLanIpv4Addresses(interfaces?: InterfaceMap): string[] {
  return getLanCandidates(interfaces).map((candidate) => candidate.address);
}

export function getLanUrls(port: number, protocol: 'http' | 'https' = 'http'): string[] {
  return getLanIpv4Addresses().map((address) => `${protocol}://${address}:${port}`);
}

function encodeDnsName(name: string): Buffer {
  const labels = name.replace(/\.$/, '').split('.');
  const parts: Buffer[] = [];
  for (const label of labels) {
    const buf = Buffer.from(label, 'utf8').subarray(0, 63);
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function record(name: string, type: number, cacheFlush: boolean, ttl: number, rdata: Buffer): Buffer {
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(type, 0);
  meta.writeUInt16BE(cacheFlush ? 0x8001 : 0x0001, 2);
  meta.writeUInt32BE(ttl, 4);
  meta.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeDnsName(name), meta, rdata]);
}

export function mdnsNames(port: number, hostname = os.hostname()): { instance: string; host: string } {
  const clean = hostname.replace(/\.local$/i, '').replace(/[^a-zA-Z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'computer';
  return {
    instance: `AirBridge ${port} on ${clean}`.slice(0, 63) + `.${MDNS_SERVICE_TYPE}`,
    host: `airbridge-${clean}`.slice(0, 63) + '.local',
  };
}

/**
 * Full DNS-SD announcement (PTR + SRV + TXT + A) for ONE interface. RFC 6762
 * §6.2: answer with the address of the interface the packet leaves on, so a
 * phone on the hotspot link only ever learns the hotspot-facing address.
 */
export function buildMdnsAnnouncement(
  port: number,
  lanIp: string,
  options: { protocol?: 'http' | 'https'; hostname?: string } = {}
): Buffer {
  const { instance, host } = mdnsNames(port, options.hostname);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0000, 0); // ID
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(0, 4); // QDCOUNT
  header.writeUInt16BE(4, 6); // ANCOUNT
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const ptr = record(MDNS_SERVICE_TYPE, 12, false, 120, encodeDnsName(instance));
  const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, (port >> 8) & 0xff, port & 0xff]), encodeDnsName(host)]);
  const srv = record(instance, 33, true, 120, srvData);
  const txtEntries = ['v=1', `scheme=${options.protocol ?? 'https'}`].map((entry) => {
    const bytes = Buffer.from(entry, 'utf8');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  const txt = record(instance, 16, true, 120, Buffer.concat(txtEntries));
  const a = record(host, 1, true, 120, Buffer.from(lanIp.split('.').map((n) => Number.parseInt(n, 10) & 0xff)));
  return Buffer.concat([header, ptr, srv, txt, a]);
}

export interface MdnsHandle {
  active: boolean;
  /** Re-read the interface list (e.g. after the computer joined a hotspot) and re-announce. */
  refresh: () => void;
  close: () => void;
}

export interface MdnsOptions {
  protocol?: 'http' | 'https';
  /** Defaults to the live LAN candidates. Must return the addresses the TLS certificate covers. */
  getAddresses?: () => string[];
}

export function startMdnsResponder(port: number, options: MdnsOptions = {}): MdnsHandle {
  const getAddresses = options.getAddresses ?? (() => getLanIpv4Addresses());
  let socket: dgram.Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let active = false;
  const joined = new Set<string>();

  const announce = () => {
    if (!socket || !active) return;
    for (const address of getAddresses()) {
      try {
        if (!joined.has(address)) {
          socket.addMembership(MDNS_MULTICAST_ADDR, address);
          joined.add(address);
        }
      } catch {
        // Already joined or the interface vanished; sending may still work.
      }
      try {
        socket.setMulticastInterface(address);
        const packet = buildMdnsAnnouncement(port, address, { protocol: options.protocol });
        socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_ADDR, () => {});
      } catch {
        // Interface went away between listing and sending.
      }
    }
  };

  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => {
      // UDP multicast is often restricted inside sandboxes/containers.
      active = false;
    });
    socket.bind(MDNS_PORT, () => {
      try {
        socket?.setMulticastTTL(255);
        socket?.setMulticastLoopback(true);
        active = true;
        announce();
        timer = setInterval(announce, 30_000);
        timer.unref();
        socket?.on('message', (msg) => {
          if (msg.includes(Buffer.from('_airbridge'))) announce();
        });
      } catch {
        active = false;
      }
    });
  } catch {
    active = false;
  }

  return {
    get active() {
      return active;
    },
    refresh: announce,
    close() {
      active = false;
      if (timer) clearInterval(timer);
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore
        }
      }
    },
  };
}
