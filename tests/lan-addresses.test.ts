// @vitest-environment node
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  classifyInterface,
  ipv4Scope,
  isVirtualInterfaceName,
  prefixLengthFromNetmask,
  sameIpv4Subnet,
  selectLanCandidates,
  type InterfaceMap,
} from '../src/server/lanAddresses.js';
import { getLanIpv4Addresses } from '../src/server/mdnsService.js';

const v4 = (address: string, netmask = '255.255.255.0', internal = false): NetworkInterfaceInfo => ({
  address,
  netmask,
  family: 'IPv4',
  mac: '02:00:00:00:00:01',
  internal,
  cidr: `${address}/${prefixLengthFromNetmask(netmask)}`,
});
const v6 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '02:00:00:00:00:01',
  internal: false,
  cidr: `${address}/64`,
  scopeid: 4,
});
const addresses = (map: InterfaceMap) => selectLanCandidates(map).map((c) => c.address);

/** The reported MacBook: campus Wi-Fi/LAN on en0, the Android hotspot on en7 (USB tether / 2nd adapter). */
const reportedMac: InterfaceMap = {
  lo0: [v4('127.0.0.1', '255.0.0.0', true), v6('::1')],
  en0: [v6('fe80::1c2b:aaaa:bbbb:cccc'), v4('10.205.95.167', '255.255.252.0')],
  en7: [v4('10.42.61.23')],
  awdl0: [v6('fe80::a8bb:ccff:fedd:eeff')],
  llw0: [v6('fe80::a8bb:ccff:fedd:eef0')],
  utun0: [v6('fe80::ce81:b1c:bd2c:69e')],
  utun3: [v4('100.96.0.7', '255.255.255.255')],
  bridge100: [v4('192.168.64.1')],
};

describe('selectLanCandidates (mocked interfaces)', () => {
  it('returns every plausibly reachable address, not just the first', () => {
    expect(addresses(reportedMac)).toEqual(['10.205.95.167', '10.42.61.23']);
  });

  it('phone hotspot only (Wi-Fi client of Android/iPhone hotspot)', () => {
    expect(addresses({ lo0: [v4('127.0.0.1', '255.0.0.0', true)], en0: [v4('10.42.61.23')] })).toEqual(['10.42.61.23']);
    expect(addresses({ en0: [v4('172.20.10.2', '255.255.255.240')] })).toEqual(['172.20.10.2']);
    expect(addresses({ en0: [v4('192.168.43.120')] })).toEqual(['192.168.43.120']);
  });

  it('Wi-Fi ranks before Ethernet, Ethernet before tether, all kept', () => {
    const map: InterfaceMap = {
      usb0: [v4('192.168.42.10')],
      eth0: [v4('192.168.1.40')],
      wlan0: [v4('192.168.0.23')],
    };
    expect(addresses(map)).toEqual(['192.168.0.23', '192.168.1.40', '192.168.42.10']);
    const kinds = selectLanCandidates(map).map((c) => c.kind);
    expect(kinds).toEqual(['wifi', 'ethernet', 'tether']);
  });

  it('multiple NICs of the same kind use natural interface order', () => {
    expect(addresses({ en10: [v4('10.0.10.2')], en2: [v4('10.0.2.2')], en7: [v4('10.0.7.2')] })).toEqual([
      '10.0.2.2',
      '10.0.7.2',
      '10.0.10.2',
    ]);
  });

  it('excludes VPN / tunnel interfaces', () => {
    const map: InterfaceMap = {
      en0: [v4('192.168.1.20')],
      utun4: [v4('10.8.0.2')],
      tun0: [v4('10.9.0.2')],
      wg0: [v4('10.10.0.2')],
      tailscale0: [v4('100.101.102.103')],
      ppp0: [v4('10.64.0.2')],
      ipsec0: [v4('10.11.0.2')],
      'Mullvad': [v4('10.12.0.2')],
      'NordLynx': [v4('10.5.0.2')],
    };
    expect(addresses(map)).toEqual(['192.168.1.20']);
  });

  it('excludes Docker / bridge / VM host-only networks', () => {
    const map: InterfaceMap = {
      en0: [v4('192.168.1.20')],
      docker0: [v4('172.17.0.1', '255.255.0.0')],
      'br-3f2a1b': [v4('172.18.0.1', '255.255.0.0')],
      veth12ab: [v4('172.17.0.5', '255.255.0.0')],
      virbr0: [v4('192.168.122.1')],
      vmnet8: [v4('192.168.200.1')],
      vboxnet0: [v4('192.168.56.1')],
      bridge100: [v4('192.168.64.1')],
      'vEthernet (WSL)': [v4('172.29.0.1', '255.255.240.0')],
      'VirtualBox Host-Only Network': [v4('192.168.57.1')],
      'VMware Network Adapter VMnet1': [v4('192.168.58.1')],
      'OpenVPN Wintun': [v4('10.13.0.2')],
      cni0: [v4('10.244.0.1')],
    };
    expect(addresses(map)).toEqual(['192.168.1.20']);
  });

  it('excludes loopback, link-local, CLAT, fake-IP, multicast and /32 addresses', () => {
    const map: InterfaceMap = {
      lo: [v4('127.0.0.1', '255.0.0.0', true)],
      en0: [v4('169.254.10.2', '255.255.0.0')],
      en1: [v4('192.0.0.2', '255.255.255.248')],
      en2: [v4('198.18.0.1', '255.254.0.0')],
      en3: [v4('224.0.0.251')],
      en4: [v4('10.20.30.40', '255.255.255.255')],
      en5: [v4('0.0.0.0', '0.0.0.0')],
      en6: [v4('192.168.5.5')],
    };
    expect(addresses(map)).toEqual(['192.168.5.5']);
  });

  it('keeps public and CGNAT addresses but ranks them after private ones', () => {
    const map: InterfaceMap = {
      en1: [v4('203.0.113.7')],
      en2: [v4('100.72.4.9', '255.192.0.0')],
      en3: [v4('192.168.1.9')],
    };
    expect(addresses(map)).toEqual(['192.168.1.9', '100.72.4.9', '203.0.113.7']);
    expect(selectLanCandidates(map).map((c) => c.scope)).toEqual(['private', 'cgnat', 'public']);
  });

  it('ignores IPv6 (global and link-local) but accepts legacy numeric family 4', () => {
    const map: InterfaceMap = {
      en0: [v6('2001:db8::5'), v6('fe80::1')],
      en1: [{ ...v4('192.168.7.7'), family: 4 as unknown as 'IPv4' }],
    };
    expect(addresses(map)).toEqual(['192.168.7.7']);
  });

  it('is independent of interface and address order', () => {
    const entries = Object.entries(reportedMac);
    const reversed = Object.fromEntries(entries.reverse());
    const rotated = Object.fromEntries([...entries.slice(3), ...entries.slice(0, 3)]);
    const shuffledAddrs = Object.fromEntries(entries.map(([k, v]) => [k, [...(v ?? [])].reverse()]));
    const expected = selectLanCandidates(reportedMac);
    expect(selectLanCandidates(reversed)).toEqual(expected);
    expect(selectLanCandidates(rotated)).toEqual(expected);
    expect(selectLanCandidates(shuffledAddrs)).toEqual(expected);
  });

  it('deduplicates an address seen on two interfaces, keeping the better-ranked one', () => {
    const result = selectLanCandidates({ eth1: [v4('192.168.1.5')], wlan0: [v4('192.168.1.5')] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ address: '192.168.1.5', interface: 'wlan0', kind: 'wifi', prefixLength: 24 });
  });

  it('getLanIpv4Addresses uses the same selection', () => {
    expect(getLanIpv4Addresses(reportedMac)).toEqual(['10.205.95.167', '10.42.61.23']);
  });
});

describe('classification helpers', () => {
  it('classifies interface names across macOS, Linux and Windows', () => {
    expect(classifyInterface('en0')).toBe('wifi');
    expect(classifyInterface('wlp3s0')).toBe('wifi');
    expect(classifyInterface('Wi-Fi')).toBe('wifi');
    expect(classifyInterface('en7')).toBe('ethernet');
    expect(classifyInterface('enp0s31f6')).toBe('ethernet');
    expect(classifyInterface('Ethernet 2')).toBe('ethernet');
    expect(classifyInterface('usb0')).toBe('tether');
    expect(classifyInterface('rndis0')).toBe('tether');
    expect(classifyInterface('something')).toBe('other');
  });

  it('flags virtual interface names', () => {
    for (const name of ['utun2', 'awdl0', 'llw0', 'docker0', 'vmnet1', 'lo0', 'Hyper-V Virtual Ethernet Adapter']) {
      expect(isVirtualInterfaceName(name)).toBe(true);
    }
    for (const name of ['en0', 'en7', 'wlan0', 'eth0', 'Wi-Fi']) expect(isVirtualInterfaceName(name)).toBe(false);
  });

  it('scopes IPv4 addresses', () => {
    expect(ipv4Scope('10.205.95.167')).toBe('private');
    expect(ipv4Scope('172.31.255.1')).toBe('private');
    expect(ipv4Scope('172.32.0.1')).toBe('public');
    expect(ipv4Scope('100.64.0.1')).toBe('cgnat');
    expect(ipv4Scope('192.0.0.2')).toBeNull();
    expect(ipv4Scope('169.254.1.1')).toBeNull();
    expect(ipv4Scope('fe80::1')).toBeNull();
  });

  it('subnet test: the reported campus address is not on the hotspot subnet', () => {
    expect(prefixLengthFromNetmask('255.255.252.0')).toBe(22);
    expect(sameIpv4Subnet('10.205.95.167', '10.42.61.1', 24)).toBe(false);
    expect(sameIpv4Subnet('10.42.61.23', '10.42.61.1', 24)).toBe(true);
    expect(sameIpv4Subnet('10.205.92.1', '10.205.95.167', 22)).toBe(true);
  });
});
