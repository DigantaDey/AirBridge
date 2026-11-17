// @vitest-environment node
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('macOS service watchdog', () => {
  it('measures an outage with suspend-aware monotonic time, not wall-clock sleep time', () => {
    const source = fs.readFileSync('scripts/mac_app.swift', 'utf8');
    expect(source).toContain('private var unresponsiveSince: DispatchTime?');
    expect(source).toContain('DispatchTime.now().uptimeNanoseconds');
    expect(source).not.toContain('now.timeIntervalSince(unresponsiveSince!');
  });
});
