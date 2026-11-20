/** Run the real Android JVM engine against the desktop implementation, no UI. */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAirBridgeServer } from '../src/server/index.js';
import { resolveTlsMaterial } from '../src/server/tls.js';

const base = await mkdtemp(path.join(os.tmpdir(), 'airbridge-native-interop-'));
const classpath = process.env.KOTLIN_ENGINE_CLASSPATH || (await readFile('android/engine/build/interop-classpath.txt', 'utf8')).trim();
const java = process.env.JAVA || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java');
const children = new Set<ChildProcess>();
const childEnv = { ...process.env };

function run(command: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    children.add(child);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk).slice(-16_000); process.stdout.write(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { output = (output + chunk).slice(-16_000); process.stderr.write(chunk); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${label} timed out\n${output}`)); }, 150_000);
    child.once('error', (error) => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer); children.delete(child);
      if (code === 0) resolve(); else reject(new Error(`${label} exited ${code}\n${output}`));
    });
  });
}

try {
  for (const tls of [false, true]) {
    const dir = path.join(base, tls ? 'tls' : 'http');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const server = await createAirBridgeServer({
      port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false,
      https: tls, tlsDir: path.join(base, 'certs'), hostClipboard: false,
      daemonConfig: { enabled: true, autoSaveToDownloads: true, downloadDir: path.join(dir, 'desktop-downloads'), notifyOnReceive: false, revealInFinder: false },
    });
    if (tls && server.tls?.caCertPem) {
      const caPath = path.join(dir, 'ca.pem');
      await writeFile(caPath, server.tls.caCertPem);
      childEnv.NODE_EXTRA_CA_CERTS = caPath;
    }
    const url = `${tls ? 'wss' : 'ws'}://127.0.0.1:${server.port}/ws`;
    console.log(`\n=== Native engine interop: ${tls ? 'TLS' : 'HTTP'} ===`);
    const started = performance.now();
    try {
      if (tls && server.tls) {
        const realPath = path.join(dir, 'real-chain.pem');
        const impostorPath = path.join(dir, 'impostor-chain.pem');
        const renewedPath = path.join(dir, 'renewed-chain.pem');
        const impostor = await resolveTlsMaterial({ tlsDir: path.join(base, 'impostor-certs') }, {});
        await rm(path.join(base, 'certs/cert.pem'));
        const renewed = await resolveTlsMaterial({ tlsDir: path.join(base, 'certs') }, {});
        await Promise.all([writeFile(realPath, server.tls.cert), writeFile(impostorPath, impostor.cert), writeFile(renewedPath, renewed.cert)]);
        await run(java, ['-Xmx128m', '-cp', classpath, 'com.airbridge.engine.TlsTrustTestKt', realPath, impostorPath, renewedPath], 'TLS trust regression');
      }
      await run(java, ['-Xmx128m', '-cp', classpath, 'com.airbridge.engine.E2EHarnessKt', 'kk', url, dir], 'Kotlin ↔ Kotlin');
      await Promise.all([
        run(java, ['-Xmx128m', '-cp', classpath, 'com.airbridge.engine.E2EHarnessKt', 'k', url, dir], 'Kotlin peer'),
        run(process.execPath, ['--import', 'tsx', 'scripts/e2e-kotlin.ts', url, path.join(dir, 'desktop-downloads'), dir], 'Desktop peer'),
      ]);
      console.log(`Native ${tls ? 'TLS' : 'HTTP'} interop passed in ${((performance.now() - started) / 1000).toFixed(2)}s (128 MiB JVM heap).`);
    } finally {
      for (const child of children) child.kill('SIGKILL');
      await server.close();
    }
  }

  // QR pairing over a phone hotspot: the Mac has a campus NIC (unreachable
  // from the phone) and a hotspot NIC. QR → pending code → TLS (QR pin) →
  // welcome → paired, rescan with a fresh code, failure classification.
  {
    const dir = path.join(base, 'qr');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const mac = (address: string, netmask: string, cidr: string) => ({
      address, netmask, family: 'IPv4' as const, mac: '02:00:00:00:00:01', internal: false, cidr,
    });
    const server = await createAirBridgeServer({
      port: 0, host: '0.0.0.0', mode: 'test', enableMdns: false,
      https: true, tlsDir: path.join(base, 'qr-certs'), hostClipboard: false,
      getNetworkInterfaces: () => ({
        lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
        en0: [mac('10.205.95.167', '255.255.252.0', '10.205.95.167/22')],
        en7: [mac('10.42.61.23', '255.255.255.0', '10.42.61.23/24')],
        utun3: [mac('100.96.0.7', '255.255.255.255', '100.96.0.7/32')],
        bridge100: [mac('192.168.64.1', '255.255.255.0', '192.168.64.1/24')],
      }),
    });
    if (server.uncoveredLanAddresses.length > 0) throw new Error(`uncovered: ${server.uncoveredLanAddresses.join(', ')}`);
    if (server.tls?.caCertPem) {
      const caPath = path.join(dir, 'ca.pem');
      await writeFile(caPath, server.tls.caCertPem);
      childEnv.NODE_EXTRA_CA_CERTS = caPath;
    }
    // Reach the server over a non-loopback address when there is one, so the
    // hub treats the phone as a LAN client (as on a real hotspot).
    const dial = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';
    console.log(`\n=== QR pairing over hotspot (phone dials ${dial}) ===`);
    const started = performance.now();
    try {
      await Promise.all([
        run(java, ['-Xmx128m', '-cp', classpath, 'com.airbridge.engine.QrPairingE2EKt', dir, dial], 'QR phone'),
        run(process.execPath, ['--import', 'tsx', 'scripts/e2e-qr-desktop.ts', `wss://127.0.0.1:${server.port}/ws`, dir], 'QR desktop'),
      ]);
      console.log(`QR hotspot pairing passed in ${((performance.now() - started) / 1000).toFixed(2)}s.`);
    } finally {
      for (const child of children) child.kill('SIGKILL');
      await server.close();
    }
  }

  // Reverse connection: every phone → computer dial is blackholed (firewall,
  // VPN, phone routing via mobile data). The desktop dials the phone's real
  // ReverseListener; TLS stays pinned to the QR; welcome must arrive.
  {
    const dir = path.join(base, 'reverse');
    const { mkdir, readFile: read } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const { buildPairingUrl } = await import('../src/client/engine/pairingUrl.js');
    const { chainAnchorPinSha256 } = await import('../src/server/tls.js');
    const server = await createAirBridgeServer({
      port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false,
      https: true, tlsDir: path.join(base, 'reverse-certs'), hostClipboard: false,
      reverseConnect: {
        intervalMs: 300,
        minSessionMs: 2_000,
        targets: async () => {
          const port = Number((await read(path.join(dir, 'rv-port.txt'), 'utf8').catch(() => '')).trim());
          return port > 0 ? [{ address: '127.0.0.1', port, source: 'static' as const }] : [];
        },
      },
    });
    const qr = buildPairingUrl({
      pairCode: server.hub.getDefaultPairCode(),
      lanUrls: [`https://127.0.0.1:${server.port}`],
      pageOrigin: `https://127.0.0.1:${server.port}`,
      pageHostname: '127.0.0.1',
      tlsPin: chainAnchorPinSha256(server.tls!.cert),
    });
    await writeFile(path.join(dir, 'qr.txt'), qr);
    console.log('\n=== Reverse connection (forward path blackholed) ===');
    const started = performance.now();
    try {
      const phone = run(java, ['-Xmx128m', '-cp', classpath, 'com.airbridge.engine.ReverseConnectE2EKt', dir], 'Reverse phone');
      const desktop = (async () => {
        const done = path.join(dir, 'k-done.txt');
        const deadline = Date.now() + 90_000;
        while (!(await read(done, 'utf8').catch(() => '')).trim()) {
          if (Date.now() > deadline) throw new Error('phone never reached welcome');
          await new Promise((r) => setTimeout(r, 50));
        }
        const clients = [...(server.hub as unknown as { clients: Map<string, { peerId: string; isLoopback: boolean; device: { name: string } }> }).clients.values()];
        const phoneClient = clients.find((c) => c.device.name === 'Reverse Phone');
        if (!phoneClient) throw new Error(`desktop has no Reverse Phone client (${clients.map((c) => c.device.name).join(', ')})`);
        if (phoneClient.isLoopback) throw new Error('dialled phone was treated as this machine');
        console.log('  ok: desktop sees the dialled phone as a LAN peer, not as the host');
        await writeFile(path.join(dir, 'd-done.txt'), 'ok');
      })();
      await Promise.all([phone, desktop]);
      console.log(`Reverse connection passed in ${((performance.now() - started) / 1000).toFixed(2)}s.`);
    } finally {
      for (const child of children) child.kill('SIGKILL');
      await server.close();
    }
  }

  // Secure code exchange + relay fallback: the Kotlin phone proves the code
  // with SPAKE2 (never sends it), checks the hub's proof over the TLS pin,
  // then reaches the computer through a relay when the direct path is
  // blocked, and moves back once it returns. The desktop checks its side.
  {
    const dir = path.join(base, 'pake');
    const { mkdir, readFile: read } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const { startRelayServer } = await import('../src/server/relay.js');
    const { chainAnchorPinSha256 } = await import('../src/server/tls.js');
    const { WarpClient } = await import('../src/client/engine/warpClient.js');
    const relay = await startRelayServer({ port: 0, host: '127.0.0.1' });
    const joins: string[] = [];
    const server = await createAirBridgeServer({
      port: 0, host: '::', mode: 'test', enableMdns: false,
      https: true, tlsDir: path.join(base, 'pake-certs'), hostClipboard: false,
      // Only 127.0.0.1 is "this computer"; the phone dials [::1] and must
      // prove the code like any device on the network.
      isLocalMachineAddress: (a) => (a ?? '').replace(/^::ffff:/, '') === '127.0.0.1',
      relay: { endpoint: `127.0.0.1:${relay.port}`, hostKeyFile: path.join(dir, 'relay-host-key') },
      // Hotspot handoff with a recording Wi-Fi joiner (no real network change in CI).
      handoff: {
        stateDir: dir,
        joiner: {
          platform: 'linux',
          unsupportedReason: async () => null,
          join: async (c) => { joins.push(`join ${c.ssid} ${c.security}`); return { device: 'wlan0', address: '192.168.49.20', previous: 'Home' }; },
          leave: async (ssid) => { joins.push(`leave ${ssid}`); return 'Home'; },
        },
      },
    });
    const clips: string[] = [];
    // The desktop peer runs on the hub computer: plain ws:// over loopback
    // (the listener serves both), exactly like the local UI.
    const mac = new WarpClient({
      wsUrl: `ws://127.0.0.1:${server.port}/ws`,
      enableWebRtc: false,
      storage: null,
      identityStore: null,
      deviceOverride: { name: 'MacBook', platform: 'macos', model: 'MacBook', formFactor: 'laptop' },
      onIncomingClipboard: (item) => clips.push(item.text ?? ''),
    });
    console.log('\n=== Secure code exchange + relay fallback (Kotlin phone ↔ desktop) ===');
    const started = performance.now();
    try {
      await mac.start();
      const waitFor = async (pred: () => boolean, label: string, ms = 60_000) => {
        const deadline = Date.now() + ms;
        while (!pred()) {
          if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await waitFor(() => Boolean(mac.getSnapshot().pairCode) && mac.getSnapshot().connectionState === 'connected', 'desktop connected');
      const code = mac.getSnapshot().pairCode;
      const pin = chainAnchorPinSha256(server.tls!.cert) ?? '';
      if (!pin) throw new Error('server has no TLS pin');
      const phone = run(java, ['-Xmx128m', '-cp', classpath, 'com.airbridge.engine.PakeInteropKt',
        `wss://[::1]:${server.port}/ws`, code, pin, dir], 'PAKE phone');
      const desktop = (async () => {
        await waitFor(() => fs.existsSync(path.join(dir, 'kotlin-ready')), 'kotlin ready', 90_000);
        const k = JSON.parse(await read(path.join(dir, 'kotlin-result.json'), 'utf8')) as { sas: string; identityKey: string; macIdentity: string };
        const snap = mac.getSnapshot();
        const p = snap.peers.find((x) => x.device?.platform === 'android');
        if (!p) throw new Error('desktop does not see the phone');
        const sec = snap.peerSecurity[p.peerId];
        if (sec.verification !== 'verified') throw new Error(`phone not verified on the desktop (${sec.verification})`);
        if (sec.identityKey !== k.identityKey) throw new Error('desktop sees a different phone identity');
        if (sec.sasCode !== k.sas) throw new Error(`SAS mismatch: desktop ${sec.sasCode} vs phone ${k.sas}`);
        console.log(`  ok: desktop verified the phone (identity match, SAS ${sec.sasCode})`);
        await writeFile(path.join(dir, 'desktop-ok'), '1');
        await waitFor(() => clips.includes('hello-through-the-relay-31337'), 'relayed clipboard', 90_000);
        const viaRelay = (server.hub as unknown as { clients: Map<string, { device: { platform: string }; remoteAddress: string; isLoopback: boolean }> }).clients;
        const relayed = [...viaRelay.values()].find((c) => c.device.platform === 'android');
        if (!relayed || relayed.isLoopback) throw new Error('relayed phone was treated as this machine');
        console.log(`  ok: E2EE clipboard arrived through the relay (relay saw ${relay.stats().bytes} bytes of ciphertext)`);
        await writeFile(path.join(dir, 'desktop-relay-ok'), '1');

        // Hotspot handoff: the phone's offer shows up on this computer; the user allows it.
        const api = `http://127.0.0.1:${server.port}/api/handoff`;
        let pendingId = '';
        const deadline = Date.now() + 30_000;
        while (!pendingId && Date.now() < deadline) {
          const list = await (await fetch(api)).json() as { offers: Array<{ id: string; state: string; deviceName: string; ssid: string }> };
          const o = list.offers.find((x) => x.state === 'pending');
          if (o) {
            if (o.deviceName !== 'Pixel (Kotlin)' || o.ssid !== 'AndroidShare_4821') throw new Error(`unexpected handoff request ${JSON.stringify(o)}`);
            pendingId = o.id;
          } else await new Promise((r) => setTimeout(r, 100));
        }
        if (!pendingId) throw new Error('handoff request never reached the computer');
        await fetch(`${api}/${pendingId}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"allow":true}' });
        await waitFor(() => joins.includes('leave AndroidShare_4821'), 'left the hotspot', 30_000);
        if (joins[0] !== 'join AndroidShare_4821 wpa2-wpa3' || joins.filter((j) => j.startsWith('join')).length !== 1) throw new Error(`unexpected joins ${joins.join(', ')}`);
        console.log(`  ok: Kotlin-sealed hotspot offer opened, allowed, joined once and left (${joins.join(' → ')})`);
        await writeFile(path.join(dir, 'desktop-handoff-ok'), '1');
      })();
      await Promise.all([phone, desktop]);
      console.log(`Secure code exchange + relay passed in ${((performance.now() - started) / 1000).toFixed(2)}s.`);
    } finally {
      mac.stop();
      for (const child of children) child.kill('SIGKILL');
      await server.close();
      await relay.close();
    }
  }
} finally {
  for (const child of children) child.kill('SIGKILL');
  await rm(base, { recursive: true, force: true });
}
