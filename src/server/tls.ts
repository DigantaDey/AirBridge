import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import { getLanIpv4Addresses } from './mdnsService.js';

/**
 * Local HTTPS provisioning.
 *
 * Browsers only expose WebCrypto (`crypto.subtle`), service workers and the
 * other APIs AirBridge depends on in a *secure context*. `http://localhost`
 * counts, but `http://<LAN-IP>` — the address a phone actually opens after
 * scanning the QR code — does not, so a phone used to land on a dead
 * "Secure connection required" screen.
 *
 * To fix that without asking users to run mkcert/openssl by hand, the server
 * keeps a small local certificate authority in `~/.airbridge/tls` (override
 * with `AIRBRIDGE_TLS_DIR`). The CA is generated once and reused; the leaf
 * certificate it signs covers localhost plus every current LAN IP and is
 * re-issued automatically when the machine's LAN IP changes. A phone that
 * installs the CA once (Settings → install CA certificate, fingerprint
 * printed by the server) therefore keeps trusting AirBridge across networks.
 *
 * Users who already have a trusted certificate (mkcert, Let's Encrypt, a
 * TLS-terminating tunnel, …) can point `AIRBRIDGE_TLS_CERT` /
 * `AIRBRIDGE_TLS_KEY` at it instead; the generated CA is then not used.
 */

export interface AirBridgeTlsMaterial {
  /** PEM private key for the leaf certificate. */
  key: string;
  /** PEM leaf certificate. For generated certs the signing CA is appended as chain. */
  cert: string;
  /** How the material was obtained. */
  source: 'generated' | 'provided';
  /** PEM of the generated local CA. Only present when `source === 'generated'`. */
  caCertPem?: string;
  /** SHA-256 fingerprint of the generated CA, colon-separated (for out-of-band verification). */
  caFingerprintSha256?: string;
  /** SHA-256 fingerprint of the leaf certificate, colon-separated. */
  leafFingerprintSha256?: string;
  /** Directory the generated material is stored in. Only for `source === 'generated'`. */
  certDir?: string;
  /** DNS names and IP addresses the leaf certificate covers. */
  hosts: string[];
}

export interface ResolveTlsOptions {
  /** Explicit on/off override. Provided cert/key paths imply `true`. */
  https?: boolean;
  /** Path to a user-supplied PEM certificate (mkcert etc.). */
  tlsCertPath?: string;
  /** Path to a user-supplied PEM private key. */
  tlsKeyPath?: string;
  /** Directory for generated CA/leaf material. Defaults to `~/.airbridge/tls`. */
  tlsDir?: string;
}

export interface ShouldEnableHttpsOptions extends ResolveTlsOptions {
  mode: 'development' | 'production' | 'test';
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Leaf validity is capped at 825 days (the maximum Apple accepts for TLS
// server certificates) and re-issued well before it lapses.
const LEAF_VALIDITY_DAYS = 825;
const CA_VALIDITY_DAYS = 3650;
const REISSUE_BEFORE_MS = 30 * DAY_MS;

function parseEnvBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(value)) return false;
  return undefined;
}

/**
 * HTTPS is on by default for real (dev/production) runs — a phone cannot use
 * the app at all over plain HTTP on a LAN IP — and off in tests unless a test
 * explicitly opts in. `AIRBRIDGE_HTTPS=0` / `--http` restores the old
 * HTTP-only behaviour (e.g. behind a TLS-terminating proxy).
 */
export function shouldEnableHttps(
  options: ShouldEnableHttpsOptions,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (options.tlsCertPath || options.tlsKeyPath || env.AIRBRIDGE_TLS_CERT || env.AIRBRIDGE_TLS_KEY) {
    return true;
  }
  if (options.https !== undefined) return options.https;
  const fromEnv = parseEnvBoolean(env.AIRBRIDGE_HTTPS);
  if (fromEnv !== undefined) return fromEnv;
  return options.mode !== 'test';
}

export function defaultTlsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AIRBRIDGE_TLS_DIR
    ? path.resolve(env.AIRBRIDGE_TLS_DIR)
    : path.join(os.homedir(), '.airbridge', 'tls');
}

/** DNS names + IPs the leaf certificate must be valid for. */
export function getCertificateHosts(): { dnsNames: string[]; ipAddresses: string[] } {
  const cleanHostname = os
    .hostname()
    .replace(/\.local$/i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  const dnsNames = Array.from(
    new Set(
      ['localhost', 'airbridge.local', cleanHostname, cleanHostname ? `${cleanHostname}.local` : ''].filter(
        Boolean
      )
    )
  );
  const ipAddresses = Array.from(new Set(['127.0.0.1', '::1', ...getLanIpv4Addresses()]));
  return { dnsNames, ipAddresses };
}

function fingerprint256(pem: string): string | undefined {
  try {
    return new crypto.X509Certificate(pem).fingerprint256;
  } catch {
    return undefined;
  }
}

function validLongEnough(pem: string): boolean {
  try {
    const cert = new crypto.X509Certificate(pem);
    const now = Date.now();
    return (
      new Date(cert.validFrom).getTime() <= now &&
      new Date(cert.validTo).getTime() > now + REISSUE_BEFORE_MS
    );
  } catch {
    return false;
  }
}

/** True when an existing leaf (signed by `caPem`) already covers every current host. */
function leafStillUsable(leafPem: string, caPem: string, dnsNames: string[], ipAddresses: string[]): boolean {
  if (!validLongEnough(leafPem)) return false;
  try {
    const leaf = new crypto.X509Certificate(leafPem);
    const ca = new crypto.X509Certificate(caPem);
    if (!leaf.verify(ca.publicKey) || leaf.issuer !== ca.subject) return false;
    for (const name of dnsNames) {
      if (leaf.checkHost(name) !== name) return false;
    }
    for (const ip of ipAddresses) {
      if (leaf.checkIP(ip) !== ip) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function joinPemChain(...pems: string[]): string {
  return pems.map((pem) => pem.trimEnd()).join('\n') + '\n';
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function writePemFile(filePath: string, contents: string): Promise<void> {
  await fs.promises.writeFile(filePath, contents, { mode: 0o600 });
  // writeFile's mode only applies on creation; tighten pre-existing files too.
  await fs.promises.chmod(filePath, 0o600).catch(() => {});
}

async function generateLocalCa(): Promise<{ cert: string; privateKey: string }> {
  const now = Date.now();
  const pems = await generate(
    [
      { name: 'commonName', value: 'AirBridge Local CA' },
      { name: 'organizationName', value: 'AirBridge (local device CA)' },
    ],
    {
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: new Date(now - DAY_MS),
      notAfterDate: new Date(now + CA_VALIDITY_DAYS * DAY_MS),
      extensions: [
        { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      ],
    }
  );
  return { cert: pems.cert, privateKey: pems.private };
}

async function generateLeaf(
  ca: { cert: string; privateKey: string },
  dnsNames: string[],
  ipAddresses: string[]
): Promise<{ cert: string; privateKey: string }> {
  const now = Date.now();
  const pems = await generate([{ name: 'commonName', value: dnsNames[0] ?? 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: ca.privateKey, cert: ca.cert },
    notBeforeDate: new Date(now - DAY_MS),
    notAfterDate: new Date(now + LEAF_VALIDITY_DAYS * DAY_MS),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          ...dnsNames.map((value) => ({ type: 2 as const, value })),
          ...ipAddresses.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  return { cert: pems.cert, privateKey: pems.private };
}

/**
 * Resolve the TLS material for the HTTPS listener: user-supplied files when
 * configured, otherwise the persistent generated CA + leaf.
 */
export async function resolveTlsMaterial(
  options: ResolveTlsOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<AirBridgeTlsMaterial> {
  const certPath = options.tlsCertPath ?? env.AIRBRIDGE_TLS_CERT;
  const keyPath = options.tlsKeyPath ?? env.AIRBRIDGE_TLS_KEY;

  if (certPath || keyPath) {
    if (!certPath || !keyPath) {
      throw new Error(
        'Both a TLS certificate and key are required — set AIRBRIDGE_TLS_CERT and AIRBRIDGE_TLS_KEY (or pass tlsCertPath/tlsKeyPath).'
      );
    }
    const [cert, key] = await Promise.all([
      fs.promises.readFile(path.resolve(certPath), 'utf8'),
      fs.promises.readFile(path.resolve(keyPath), 'utf8'),
    ]);
    const { dnsNames, ipAddresses } = getCertificateHosts();
    return {
      key,
      cert,
      source: 'provided',
      leafFingerprintSha256: fingerprint256(cert),
      hosts: [...dnsNames, ...ipAddresses],
    };
  }

  const certDir = options.tlsDir ? path.resolve(options.tlsDir) : defaultTlsDir(env);
  await fs.promises.mkdir(certDir, { recursive: true, mode: 0o700 });

  const caCertPath = path.join(certDir, 'ca.pem');
  const caKeyPath = path.join(certDir, 'ca-key.pem');
  const leafCertPath = path.join(certDir, 'cert.pem');
  const leafKeyPath = path.join(certDir, 'key.pem');

  const { dnsNames, ipAddresses } = getCertificateHosts();

  let caCert = await readFileIfExists(caCertPath);
  let caKey = await readFileIfExists(caKeyPath);
  if (!caCert || !caKey || !validLongEnough(caCert)) {
    const generated = await generateLocalCa();
    caCert = generated.cert;
    caKey = generated.privateKey;
    await writePemFile(caCertPath, caCert);
    await writePemFile(caKeyPath, caKey);
  }

  // Re-issue the leaf whenever the machine's addresses change (new Wi-Fi
  // network / new DHCP lease) so the certificate the phone sees always
  // covers the URL it opened — the CA it already trusts stays the same.
  let leafCert = await readFileIfExists(leafCertPath);
  let leafKey = await readFileIfExists(leafKeyPath);
  if (!leafCert || !leafKey || !leafStillUsable(leafCert, caCert, dnsNames, ipAddresses)) {
    const generated = await generateLeaf({ cert: caCert, privateKey: caKey }, dnsNames, ipAddresses);
    leafCert = generated.cert;
    leafKey = generated.privateKey;
    await writePemFile(leafCertPath, leafCert);
    await writePemFile(leafKeyPath, leafKey);
  }

  return {
    key: leafKey,
    cert: joinPemChain(leafCert, caCert),
    source: 'generated',
    caCertPem: caCert,
    caFingerprintSha256: fingerprint256(caCert),
    leafFingerprintSha256: fingerprint256(leafCert),
    certDir,
    hosts: [...dnsNames, ...ipAddresses],
  };
}

/** Loopback requests keep plain HTTP: `http://localhost` is already a secure context. */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.replace(/^::ffff:/, '');
  return normalized === '::1' || (net.isIPv4(normalized) && normalized.startsWith('127.'));
}
