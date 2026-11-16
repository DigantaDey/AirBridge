// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildPairingUrl, choosePrimaryEndpoint, MAX_QR_ALTERNATES } from '../src/client/engine/pairingUrl.js';

const PIN = 'q'.repeat(43);
const CAMPUS = 'https://10.205.95.167:3000';
const HOTSPOT = 'https://10.42.61.23:3000';
const local = { pageOrigin: 'https://localhost:3000', pageHostname: 'localhost' };

describe('buildPairingUrl', () => {
  it('lists every other advertised endpoint as an alternate and adds the TLS pin', () => {
    const url = new URL(buildPairingUrl({ pairCode: 'ABC234', lanUrls: [CAMPUS, HOTSPOT], tlsPin: PIN, ...local }));
    expect(url.origin).toBe(CAMPUS);
    expect(url.searchParams.get('pair')).toBe('ABC234');
    expect(url.searchParams.get('alt')).toBe('10.42.61.23');
    expect(url.searchParams.get('ca')).toBe(PIN);
  });

  it('an unreachable endpoint that sorts first does not hide the reachable one', () => {
    // Whatever the order, the QR carries all endpoints; the phone ranks them
    // by its own networks (HotspotPairingTestKt) and races them.
    for (const order of [[CAMPUS, HOTSPOT], [HOTSPOT, CAMPUS]]) {
      const url = new URL(buildPairingUrl({ pairCode: 'ABC234', lanUrls: order, tlsPin: PIN, ...local }));
      const hosts = [url.hostname, ...(url.searchParams.get('alt') ?? '').split(',')];
      expect(new Set(hosts)).toEqual(new Set(['10.205.95.167', '10.42.61.23']));
    }
  });

  it('uses the endpoint the user picked as primary', () => {
    const url = new URL(
      buildPairingUrl({ pairCode: 'ABC234', lanUrls: [CAMPUS, HOTSPOT], preferredUrl: HOTSPOT, tlsPin: PIN, ...local })
    );
    expect(url.origin).toBe(HOTSPOT);
    expect(url.searchParams.get('alt')).toBe('10.205.95.167');
  });

  it('ignores a preferred endpoint that is no longer advertised (address changed)', () => {
    expect(
      choosePrimaryEndpoint({ lanUrls: [HOTSPOT], preferredUrl: 'https://10.42.99.5:3000', ...local })
    ).toBe(HOTSPOT);
  });

  it('prefers the page origin when the page was opened over the network', () => {
    expect(
      choosePrimaryEndpoint({ lanUrls: [CAMPUS, HOTSPOT], pageOrigin: HOTSPOT, pageHostname: '10.42.61.23' })
    ).toBe(HOTSPOT);
  });

  it('only advertises same-scheme, same-port alternates and caps them', () => {
    const many = Array.from({ length: 9 }, (_, i) => `https://192.168.1.${i + 10}:3000`);
    const url = new URL(
      buildPairingUrl({
        pairCode: 'ABC234',
        lanUrls: [...many, 'http://192.168.9.9:3000', 'https://192.168.9.10:4000'],
        tlsPin: PIN,
        ...local,
      })
    );
    const alt = url.searchParams.get('alt')!.split(',');
    expect(alt).toHaveLength(MAX_QR_ALTERNATES);
    expect(alt).not.toContain('192.168.9.9');
    expect(alt).not.toContain('192.168.9.10');
    expect(alt).not.toContain(url.hostname);
  });

  it('omits the pin for http and for malformed pins', () => {
    const http = buildPairingUrl({ pairCode: 'ABC234', lanUrls: ['http://192.168.1.5:3000'], tlsPin: PIN, ...local, pageOrigin: 'http://localhost:3000' });
    expect(new URL(http).searchParams.has('ca')).toBe(false);
    const bad = buildPairingUrl({ pairCode: 'ABC234', lanUrls: [HOTSPOT], tlsPin: 'short', ...local });
    expect(new URL(bad).searchParams.has('ca')).toBe(false);
  });

  it('stays readable by legacy scanners (host + pair) and is empty without a code', () => {
    const url = buildPairingUrl({ pairCode: 'ABC234', lanUrls: [HOTSPOT], tlsPin: null, ...local });
    expect(url).toBe(`${HOTSPOT}/?pair=ABC234`);
    expect(buildPairingUrl({ pairCode: '', lanUrls: [HOTSPOT], ...local })).toBe('');
  });
});
