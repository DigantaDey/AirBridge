// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBackgroundStorage } from '../src/server/backgroundClipboard.js';
import { isValidPairCode, normalizePairCode } from '../src/shared/protocol.js';

describe('background clipboard peer', () => {
  it('persists its identity and pairing group across daemon restarts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-background-peer-'));
    const file = path.join(dir, 'peer.json');
    const storage = createBackgroundStorage(file);
    storage.setItem('airbridge:background:deviceId', '0123456789abcdef');
    storage.setItem('airbridge:background:pairCode', normalizePairCode('abc234'));

    const reloaded = createBackgroundStorage(file);
    expect(reloaded.getItem('airbridge:background:deviceId')).toBe('0123456789abcdef');
    const code = reloaded.getItem('airbridge:background:pairCode') ?? '';
    expect(isValidPairCode(code)).toBe(true);
    expect(code).toBe('ABC234');
  });

  it('keeps daemon state private and null storage strictly in memory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-background-private-'));
    try {
      const file = path.join(dir, 'peer.json');
      const storage = createBackgroundStorage(file);
      storage.setItem('pref', 'one'); storage.setItem('pref', 'two');
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(['peer.json']);
      const memory = createBackgroundStorage(null);
      memory.setItem('pref', 'memory');
      expect(createBackgroundStorage(null).getItem('pref')).toBeNull();
      expect(createBackgroundStorage(file).getItem('pref')).toBe('two');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('starts cleanly when the state file is missing or corrupt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-background-peer-'));
    const missing = createBackgroundStorage(path.join(dir, 'missing.json'));
    expect(missing.getItem('airbridge:background:pairCode')).toBeNull();

    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json', 'utf8');
    const recovered = createBackgroundStorage(corrupt);
    recovered.setItem('airbridge:background:pairCode', 'ABC234');
    expect(createBackgroundStorage(corrupt).getItem('airbridge:background:pairCode')).toBe('ABC234');
  });
});
