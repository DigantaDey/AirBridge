/** Run the real Android JVM engine against the desktop implementation, no UI. */
import { spawn, type ChildProcess } from 'node:child_process';
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
} finally {
  for (const child of children) child.kill('SIGKILL');
  await rm(base, { recursive: true, force: true });
}
