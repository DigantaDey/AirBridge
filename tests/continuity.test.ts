import { describe, expect, it } from 'vitest';
import {
  SCREEN_FRAME_AAD_LENGTH,
  SCREEN_FRAME_HEADER_LENGTH,
  buildVCard,
  buildVCards,
  callPartyLabel,
  clampScreenParams,
  contactMatches,
  decodeScreenFrame,
  dialableNumber,
  encodeScreenFrame,
  encodeScreenFrameAad,
  nextScreenQuality,
  parseVCards,
  sanitizeCall,
  sanitizeContact,
  sanitizeFeatures,
  sanitizePhoneNumber,
  type ContactCard,
} from '../src/shared/continuity.js';
import { decryptMediaFrame, encryptMediaFrame } from '../src/client/engine/crypto.js';
import { FRAME_SCREEN } from '../src/shared/protocol.js';

const ada: ContactCard = {
  name: 'Ada Lovelace',
  phones: [{ number: '+44 20 7946 0958', label: 'mobile' }, { number: '(020) 7946-0000', label: 'work' }],
  emails: [{ address: 'ada@example.org', label: 'home' }],
  organization: 'Analytical Engines; Ltd, London',
  note: 'Line one\nLine two, with comma',
};

describe('vCard', () => {
  it('builds RFC-conformant vCard 3.0 with escaping and CRLF line endings', () => {
    const v = buildVCard(ada);
    expect(v.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
    expect(v).toContain('N:Lovelace;Ada;;;\r\n');
    expect(v).toContain('FN:Ada Lovelace\r\n');
    expect(v).toContain('ORG:Analytical Engines\\; Ltd\\, London\r\n');
    expect(v).toContain('TEL;TYPE=CELL:+44 20 7946 0958\r\n');
    expect(v).toContain('TEL;TYPE=WORK:(020) 7946-0000\r\n');
    expect(v).toContain('EMAIL;TYPE=INTERNET,HOME:ada@example.org\r\n');
    expect(v).toContain('NOTE:Line one\\nLine two\\, with comma\r\n');
    expect(v.endsWith('END:VCARD\r\n')).toBe(true);
  });

  it('round-trips through the parser', () => {
    const [parsed] = parseVCards(buildVCard(ada));
    expect(parsed).toEqual({
      name: 'Ada Lovelace',
      phones: [{ number: '+44 20 7946 0958', label: 'mobile' }, { number: '(020) 7946-0000', label: 'work' }],
      emails: [{ address: 'ada@example.org', label: 'home' }],
      organization: 'Analytical Engines; Ltd, London',
      note: 'Line one\nLine two, with comma',
    });
  });

  it('folds long lines at 75 octets without splitting UTF-8 characters', () => {
    const card: ContactCard = { name: 'Zoë ' + 'Ünïcødé '.repeat(20).trim(), phones: [], emails: [] };
    const v = buildVCard(card);
    for (const line of v.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(parseVCards(v)[0].name).toBe(card.name);
  });

  it('reads Android-style vCard 2.1 with quoted-printable names and soft breaks', () => {
    const v21 = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen;;;',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BC=',
      'ller',
      'TEL;CELL;PREF:+49 151 2345678',
      'TEL;HOME:030 123456',
      'EMAIL;HOME:jm@example.de',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N:Solo;;;;',
      'TEL;WORK;VOICE:555-0100',
      'END:VCARD',
    ].join('\r\n');
    const cards = parseVCards(v21);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      name: 'Jürgen Müller',
      phones: [{ number: '+49 151 2345678', label: 'mobile' }, { number: '030 123456', label: 'home' }],
      emails: [{ address: 'jm@example.de', label: 'home' }],
    });
    expect(cards[1]).toMatchObject({ name: 'Solo', phones: [{ number: '555-0100', label: 'work' }] });
  });

  it('reads vCard 4.0 with groups, tel: URIs and folded lines; skips nameless cards', () => {
    const v4 = [
      'BEGIN:VCARD', 'VERSION:4.0', 'FN:Grace', ' Hopper', 'item1.TEL;VALUE=uri;TYPE="voice,cell":tel:+1-202-555-0143',
      'item1.X-ABLabel:Navy', 'EMAIL;TYPE=work:grace@navy.mil', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:4.0', 'NOTE:no identity', 'END:VCARD',
    ].join('\n');
    const cards = parseVCards(v4);
    expect(cards).toEqual([
      { name: 'GraceHopper', phones: [{ number: '+1-202-555-0143', label: 'mobile' }], emails: [{ address: 'grace@navy.mil', label: 'work' }] },
    ]);
  });

  it('joins multiple cards and ignores garbage', () => {
    const two = buildVCards([ada, { name: 'Bob', phones: [{ number: '123' }], emails: [] }]);
    expect(parseVCards(two).map((c) => c.name)).toEqual(['Ada Lovelace', 'Bob']);
    expect(parseVCards('hello world')).toEqual([]);
    expect(parseVCards('END:VCARD\r\nFN:x')).toEqual([]);
  });
});

describe('contact validation', () => {
  it('sanitizes untrusted contacts', () => {
    expect(sanitizeContact(null)).toBeNull();
    expect(sanitizeContact({ name: '   ', phones: [], emails: [] })).toBeNull();
    expect(sanitizeContact({ phones: [{ number: '+1 555 0100' }] })?.name).toBe('+1 555 0100');
    const c = sanitizeContact({
      id: 'lookup/1', name: 'Eve\u0000\u0007 ', starred: true,
      phones: [{ number: 'javascript:alert(1)' }, { number: '+1 (555) 010-0199', label: 'mobile' }],
      emails: [{ address: 'not an email' }, { address: 'eve@example.com' }],
      organization: 'x'.repeat(1000),
    });
    expect(c).toMatchObject({ id: 'lookup/1', name: 'Eve', starred: true, phones: [{ number: '+1 (555) 010-0199', label: 'mobile' }], emails: [{ address: 'eve@example.com' }] });
    expect(c!.organization!.length).toBe(256);
  });

  it('only dials digits and dial symbols', () => {
    expect(sanitizePhoneNumber('+1 (555) 010-0199')).toBe('+1 (555) 010-0199');
    expect(sanitizePhoneNumber('555; DROP TABLE')).toBeUndefined();
    expect(sanitizePhoneNumber('---')).toBeUndefined();
    expect(dialableNumber('+1 (555) 010-0199')).toBe('+15550100199');
    expect(dialableNumber('*#06#')).toBe('*#06#');
    expect(dialableNumber('12+34')).toBe('1234');
    expect(dialableNumber('tel:123')).toBeUndefined();
  });

  it('searches names, organisations, emails and digits', () => {
    expect(contactMatches(ada, 'lovel')).toBe(true);
    expect(contactMatches(ada, 'ANALYTICAL')).toBe(true);
    expect(contactMatches(ada, 'ada@')).toBe(true);
    expect(contactMatches(ada, '7946 09')).toBe(true);
    expect(contactMatches(ada, '79')).toBe(false); // too few digits to be meaningful
    expect(contactMatches({ name: 'Zoë', phones: [], emails: [] }, 'zoe')).toBe(true);
    expect(contactMatches(ada, '')).toBe(true);
  });

  it('filters advertised features', () => {
    expect(sanitizeFeatures(['calls.control', 'bogus', 'screen.view', 'calls.control', 7])).toEqual(['calls.control', 'screen.view']);
    expect(sanitizeFeatures('calls.control')).toEqual([]);
  });
});

describe('call state validation', () => {
  it('accepts well-formed call state and drops unknown fields', () => {
    const call = sanitizeCall({
      callId: '0123456789abcdef', state: 'ringing', direction: 'incoming', number: '+1 555 0100', name: 'Mum',
      updatedAt: 5, actions: ['answer', 'reject', 'answer', 'explode'], audioRoute: 'bluetooth', evil: true,
    });
    expect(call).toEqual({
      callId: '0123456789abcdef', state: 'ringing', direction: 'incoming', number: '+1 555 0100', name: 'Mum',
      updatedAt: 5, actions: ['answer', 'reject'], audioRoute: 'bluetooth',
    });
    expect(callPartyLabel(call!)).toBe('Mum');
    expect(callPartyLabel({ number: '123' })).toBe('123');
    expect(callPartyLabel({})).toBe('Unknown caller');
  });

  it('rejects malformed call state', () => {
    expect(sanitizeCall({ callId: 'short', state: 'ringing' })).toBeNull();
    expect(sanitizeCall({ callId: '0123456789abcdef', state: 'exploding' })).toBeNull();
    expect(sanitizeCall('x')).toBeNull();
    expect(sanitizeCall({ callId: '0123456789abcdef', state: 'active', number: 'evil<script>' }, 9)).toEqual({
      callId: '0123456789abcdef', state: 'active', direction: 'incoming', updatedAt: 9, actions: [],
    });
  });
});

describe('screen frames', () => {
  const header = { sessionId: 'a1b2c3d4e5f60718', seq: 42, codec: 1, width: 1080, height: 2400 };

  it('encodes a fixed 26-byte authenticated header', () => {
    const aad = encodeScreenFrameAad(header);
    expect(aad.byteLength).toBe(SCREEN_FRAME_AAD_LENGTH);
    expect(aad[0]).toBe(FRAME_SCREEN);
    expect(new TextDecoder().decode(aad.subarray(1, 17))).toBe(header.sessionId);
    const view = new DataView(aad.buffer);
    expect(view.getUint32(17)).toBe(42);
    expect(aad[21]).toBe(1);
    expect(view.getUint16(22)).toBe(1080);
    expect(view.getUint16(24)).toBe(2400);
    expect(() => encodeScreenFrameAad({ ...header, sessionId: 'nothex' })).toThrow();
    expect(() => encodeScreenFrameAad({ ...header, width: 0 })).toThrow();
    expect(() => encodeScreenFrameAad({ ...header, seq: -1 })).toThrow();
  });

  it('seals with AES-GCM bound to the header; tampering or splicing fails', async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
    const aad = encodeScreenFrameAad(header);
    const { iv, ciphertext } = await encryptMediaFrame(key, aad, jpeg);
    const wire = encodeScreenFrame(aad, iv, ciphertext);
    expect(wire.byteLength).toBe(SCREEN_FRAME_HEADER_LENGTH + jpeg.byteLength + 16);

    const decoded = decodeScreenFrame(wire);
    expect(decoded).toMatchObject(header);
    expect(await decryptMediaFrame(key, decoded.aad, decoded.iv, decoded.ciphertext)).toEqual(jpeg);

    // A relay rewriting the sequence (replay/reorder) or session (splice) breaks the tag.
    const tamper = async (mutate: (bytes: Uint8Array) => void) => {
      const forged = wire.slice();
      mutate(forged);
      const f = decodeScreenFrame(forged);
      await expect(decryptMediaFrame(key, f.aad, f.iv, f.ciphertext)).rejects.toThrow();
    };
    await tamper((b) => { b[5] = b[5] === 0x30 ? 0x31 : 0x30; }); // other session (still valid hex)
    await tamper((b) => { b[20] ^= 0x01; }); // replayed/reordered sequence
    await tamper((b) => { b[23] ^= 0x10; }); // altered dimensions
    await tamper((b) => { b[b.length - 1] ^= 0x01; }); // altered pixels
    // A file chunk (no AAD) cannot be passed off as a frame and vice versa.
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource)).rejects.toThrow();
  });

  it('rejects malformed frames', () => {
    expect(() => decodeScreenFrame(new Uint8Array(10))).toThrow();
    const aad = encodeScreenFrameAad(header);
    const wire = encodeScreenFrame(aad, new Uint8Array(12), new Uint8Array(16));
    wire[0] = 0x01;
    expect(() => decodeScreenFrame(wire)).toThrow();
    expect(() => encodeScreenFrame(aad, new Uint8Array(8), new Uint8Array(16))).toThrow();
  });

  it('clamps capture parameters and adapts quality to congestion', () => {
    expect(clampScreenParams(99999, 240)).toEqual({ maxWidth: 2560, maxFps: 30 });
    expect(clampScreenParams(10, 0)).toEqual({ maxWidth: 320, maxFps: 1 });
    expect(clampScreenParams('x', null)).toEqual({ maxWidth: 1280, maxFps: 15 });
    expect(nextScreenQuality(0.7, 50)).toBe(0.72);
    expect(nextScreenQuality(0.7, 300)).toBe(0.65);
    expect(nextScreenQuality(0.7, 900)).toBe(0.52);
    expect(nextScreenQuality(0.31, 900)).toBe(0.3);
    expect(nextScreenQuality(0.85, 10)).toBe(0.85);
  });
});
