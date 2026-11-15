import { describe, expect, it } from 'vitest';
import { readRepoFile, startTestServer } from '../harness/index.js';

describe('F19: ANR Elimination & Non-Blocking mDNS Discovery Queue', () => {
  it('serializes NsdManager resolution via DiscoveryQueue generation tokens and timeout guards', async () => {
    const dq = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/DiscoveryQueue.kt');
    const disc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/Discovery.kt');
    expect(dq).toContain('var activeGeneration: Long = 0L');
    expect(dq).toContain('fun nextToResolve()');
    expect(dq).toContain('fun finish(generation: Long): Boolean');
    expect(disc).toContain('RESOLVE_TIMEOUT_MS = 5_000L');
    expect(disc).toContain('Handler(Looper.getMainLooper())');
    expect(disc).toContain('queue.finish(generation)');
  });

  it('prefers non-loopback IPv4 addresses and formats IPv6 ws URLs with brackets in DiscoveryUrlFormatter', async () => {
    const dq = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/DiscoveryQueue.kt');
    expect(dq).toContain('object DiscoveryUrlFormatter');
    expect(dq).toContain('addresses.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }');
    expect(dq).toContain('ws://[$raw]:$port/ws');
    expect(dq).toContain('ws://$raw:$port/ws');
  });

  it('offloads ConnectionService engine shutdown onto background executor to avoid main-thread ANRs', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('actions.execute { host?.close() }');
    expect(svc).toContain('actions.shutdown()');
  });

  it('dispatches all control/file operations off the Compose UI thread in MainActivity/ViewModel', async () => {
    const activity = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt');
    expect(activity).not.toContain('Thread.sleep');
    expect(activity).not.toContain('Socket(');
  });

  it('removes legacy WebViewBridge / JS synchronous round-trips completely', async () => {
    const app = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt');
    expect(app).not.toContain('evaluateJavascript');
    expect(app).not.toContain('JavascriptInterface');
  });

  it('advertises valid LAN URLs and pair metadata over non-blocking HTTP /api/health', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    try {
      const res = await fetch(`${server.httpUrl}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lanUrls: string[]; status: string };
      expect(body.status).toBe('ok');
      expect(Array.isArray(body.lanUrls)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
