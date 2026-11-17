// @vitest-environment node
/**
 * Regression: posting a macOS notification compiled a Swift helper with a
 * *synchronous* swiftc call (5–30 s). That froze the service, /api/health
 * stopped answering, and the macOS app restarted the service in a loop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
let originalPath: string | undefined;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-notifier-'));
  const fakeBin = path.join(dir, 'fakebin');
  fs.mkdirSync(fakeBin);
  // swiftc that takes 3 s, then "compiles" a notifier that records its arguments.
  fs.writeFileSync(path.join(fakeBin, 'swiftc'), `#!/bin/bash
sleep 3
out=""
while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; fi; shift; done
printf '#!/bin/bash\\necho "$*" >> "${dir}/notified"\\n' > "$out"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'osascript'), `#!/bin/bash\necho fallback >> "${dir}/fallback"\n`, { mode: 0o755 });
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  process.env.AIRBRIDGE_NOTIFIER_DIR = path.join(dir, 'bin');
});

afterAll(() => {
  process.env.PATH = originalPath;
  delete process.env.AIRBRIDGE_NOTIFIER_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function eventually(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe('macOS notifications never block the service', () => {
  it('builds the Swift notifier in the background and uses osascript meanwhile', async () => {
    const { postMacOsNotification, resetMacNotifierForTests } = await import('../src/server/macNotification.js');
    resetMacNotifierForTests();

    const started = Date.now();
    let lag = Infinity;
    const tick = new Promise<void>((resolve) => setTimeout(() => { lag = Date.now() - started; resolve(); }, 0));
    postMacOsNotification('Hello', 'From phone', 'Messages', 'darwin');
    const callTook = Date.now() - started;
    await tick;

    expect(callTook).toBeLessThan(500);
    expect(lag).toBeLessThan(500);
    // While compiling: the notification still shows via osascript.
    expect(await eventually(() => fs.existsSync(path.join(dir, 'fallback')), 2_000)).toBe(true);

    // The helper appears atomically once swiftc finishes, then is used.
    const notifier = path.join(dir, 'bin', 'AirBridgeNotifier');
    expect(await eventually(() => fs.existsSync(notifier), 8_000)).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'bin')).filter((f) => f.includes('tmp') || f.endsWith('.swift'))).toEqual([]);
    postMacOsNotification('Second', 'Body', 'Messages', 'darwin');
    expect(await eventually(() => fs.existsSync(path.join(dir, 'notified')), 3_000)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'notified'), 'utf8')).toContain('Second Body Messages');
  }, 20_000);

  it('does nothing on other platforms', async () => {
    const { postMacOsNotification } = await import('../src/server/macNotification.js');
    expect(() => postMacOsNotification('x', 'y', undefined, 'linux')).not.toThrow();
  });
});
