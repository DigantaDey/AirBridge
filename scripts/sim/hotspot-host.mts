// Host side of scripts/sim/run-scenario.sh: the real server on the namespace's real interfaces;
// prints the advertised endpoints and writes the QR exactly as PairingDock renders it on the Mac.
import { createAirBridgeServer } from '../../src/server/index.ts';
import { buildPairingUrl } from '../../src/client/engine/pairingUrl.ts';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
mkdirSync('/tmp/airbridge-sim', { recursive: true });
rmSync('/tmp/airbridge-sim/certs', { recursive: true, force: true });
const server = await createAirBridgeServer({ port: 3000, host: '0.0.0.0', mode: 'test', https: true, enableMdns: false, hostClipboard: false, tlsDir: '/tmp/airbridge-sim/certs', daemonConfig: { enabled: false } as never });
const code = server.hub.getDefaultPairCode();
console.log('advertised', JSON.stringify(server.lanEndpoints.map((e) => `${e.interface}=${e.address}`)));
console.log('uncovered', JSON.stringify(server.uncoveredLanAddresses));
// What PairingDock now renders when opened on the Mac itself (localhost).
const qr = buildPairingUrl({ pairCode: code, lanUrls: server.lanUrls, pageOrigin: 'https://localhost:3000', pageHostname: 'localhost', tlsPin: server.tls?.pinSha256 ?? null });
console.log('QR', qr);
writeFileSync('/tmp/airbridge-sim/qr.txt', qr);
