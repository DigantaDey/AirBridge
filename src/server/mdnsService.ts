import dgram from 'node:dgram';
import os from 'node:os';

const MDNS_MULTICAST_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

export function getLanUrls(port: number): string[] {
  const interfaces = os.networkInterfaces();
  const urls: string[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    // Skip virtual docker/bridge interfaces where possible, prioritize en0/wlan0/eth0
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        const url = `http://${addr.address}:${port}`;
        if (/^(en|wlan|wi-fi|eth)/i.test(name)) {
          urls.unshift(url);
        } else {
          urls.push(url);
        }
      }
    }
  }

  return Array.from(new Set(urls));
}

function encodeDnsName(name: string): Buffer {
  const labels = name.replace(/\.$/, '').split('.');
  const parts: Buffer[] = [];
  for (const label of labels) {
    const buf = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function buildMdnsPtrAnnouncement(port: number, lanIp: string): Buffer {
  const serviceName = '_airbridge._tcp.local';
  const hostname = `${os.hostname().replace(/[^a-zA-Z0-9-]/g, '') || 'macbook'}.airbridge.local`;

  // DNS Header: QR=1 (response), AA=1 (authoritative), ANCOUNT=2
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0000, 0); // ID
  header.writeUInt16BE(0x8400, 2); // Flags: Standard query response, authoritative
  header.writeUInt16BE(0, 4); // QDCOUNT
  header.writeUInt16BE(2, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT

  // Answer 1: PTR _airbridge._tcp.local -> hostname
  const qName = encodeDnsName(serviceName);
  const targetName = encodeDnsName(`AirBridge (${port}).${serviceName}`);
  const ptrMeta = Buffer.alloc(10);
  ptrMeta.writeUInt16BE(12, 0); // TYPE PTR
  ptrMeta.writeUInt16BE(1, 2); // CLASS IN
  ptrMeta.writeUInt32BE(120, 4); // TTL 120s
  ptrMeta.writeUInt16BE(targetName.length, 8);

  // Answer 2: A record for airbridge.local -> lanIp
  const aName = encodeDnsName(hostname);
  const ipOctets = lanIp.split('.').map((n) => Number.parseInt(n, 10) & 0xff);
  const aMeta = Buffer.alloc(14);
  aMeta.writeUInt16BE(1, 0); // TYPE A
  aMeta.writeUInt16BE(0x8001, 2); // CLASS IN + cache-flush
  aMeta.writeUInt32BE(120, 4); // TTL 120s
  aMeta.writeUInt16BE(4, 8); // RDLENGTH 4
  aMeta[10] = ipOctets[0] ?? 127;
  aMeta[11] = ipOctets[1] ?? 0;
  aMeta[12] = ipOctets[2] ?? 0;
  aMeta[13] = ipOctets[3] ?? 1;

  return Buffer.concat([header, qName, ptrMeta, targetName, aName, aMeta]);
}

export interface MdnsHandle {
  active: boolean;
  close: () => void;
}

export function startMdnsResponder(port: number): MdnsHandle {
  const lanUrls = getLanUrls(port);
  const primaryIp = lanUrls[0]?.replace(/^https?:\/\//, '').split(':')[0];
  if (!primaryIp) {
    return { active: false, close: () => {} };
  }

  let socket: dgram.Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let active = false;

  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', () => {
      // Silently ignore UDP multicast restrictions inside sandboxed containers
      active = false;
    });

    socket.bind(MDNS_PORT, () => {
      try {
        socket?.addMembership(MDNS_MULTICAST_ADDR);
        socket?.setMulticastTTL(255);
        socket?.setMulticastLoopback(true);
        active = true;

        const packet = buildMdnsPtrAnnouncement(port, primaryIp);
        const announce = () => {
          if (!socket || !active) return;
          socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_ADDR, () => {});
        };

        announce();
        timer = setInterval(announce, 30_000);
        timer.unref();

        socket?.on('message', (msg) => {
          if (msg.includes(Buffer.from('_airbridge'))) {
            announce();
          }
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
