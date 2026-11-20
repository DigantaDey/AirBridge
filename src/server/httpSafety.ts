import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';

/** Express 4 does not forward rejected async handlers to its error middleware. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => { void Promise.resolve().then(() => handler(req, res, next)).catch(next); };
}

let cachedSystemHosts: { at: number; set: Set<string> } | null = null;
const HOST_CACHE_TTL_MS = 2_000;

function systemInterfaceHosts(): Set<string> {
  const now = Date.now();
  if (!cachedSystemHosts || now - cachedSystemHosts.at > HOST_CACHE_TTL_MS) {
    const set = new Set<string>(['localhost', '127.0.0.1', '::1', 'airbridge.local']);
    const cleanHost = os.hostname().replace(/\.local$/i, '').toLowerCase();
    if (cleanHost) {
      set.add(cleanHost);
      set.add(`${cleanHost}.local`);
    }
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const info of list) {
        const addr = info.address.split('%')[0]!.replace(/^::ffff:/, '').toLowerCase();
        if (addr) set.add(addr);
      }
    }
    cachedSystemHosts = { at: now, set };
  }
  return cachedSystemHosts.set;
}

/** Parse a `Host` header (`host[:port]` or `[ipv6][:port]`) into normalized hostname + optional port. */
export function parseHostHeader(rawHost: string | undefined): { hostname: string; port: string | null } | null {
  if (!rawHost || typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed || trimmed.length > 255 || /[\s/\\?#@]/.test(trimmed)) return null;
  if (trimmed.startsWith('[')) {
    const m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(trimmed);
    if (!m) return null;
    if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return null;
    return { hostname: m[1]!.replace(/^::ffff:/, ''), port: m[2] ?? null };
  }
  // Unbracketed IPv6 literal without port (e.g. "::1")
  if (trimmed.includes(':') && trimmed.indexOf(':') !== trimmed.lastIndexOf(':')) {
    if (!/^[0-9a-f:.]+$/.test(trimmed)) return null;
    return { hostname: trimmed.replace(/^::ffff:/, ''), port: null };
  }
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (!m) return null;
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return null;
  return { hostname: m[1]!, port: m[2] ?? null };
}

/**
 * DNS-rebinding defense: verifies the `Host` header matches `localhost`,
 * loopback (`127.0.0.1`, `[::1]`, `::1`), `.local` mDNS hostname, or one of
 * this computer's active LAN interface IPs (plus any caller-supplied hosts).
 * Rejects rebound external domains such as `evil.com` or `127.0.0.1.nip.io`.
 */
export function isAllowedHostHeader(
  req: IncomingMessage,
  allowedHosts?: Iterable<string>,
): boolean {
  const rawHost = req.headers.host;
  // HTTP/1.0 or internal socket calls without a Host header are rejected when present/malformed,
  // but if Host is present it must match our allowlist.
  if (rawHost === undefined) return true;
  const parsed = parseHostHeader(rawHost);
  if (!parsed) return false;
  const { hostname } = parsed;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }
  // Allow RFC1918 private IPv4 and link-local (169.254/16, fe80::) / ULA (fc00::/7) IPv6
  // numeric address literals used in direct LAN/hotspot pairing; DNS-rebound hostnames still fail below.
  if (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname.startsWith('fe80:') ||
    hostname.startsWith('fc') ||
    hostname.startsWith('fd')
  ) {
    if (isIP(hostname) !== 0) {
      return true;
    }
  }
  if (allowedHosts) {
    for (const candidate of allowedHosts) {
      const clean = candidate.trim().replace(/^\[|\]$/g, '').split('%')[0]!.replace(/^::ffff:/, '').toLowerCase();
      if (clean && clean === hostname) return true;
    }
  }
  return systemInterfaceHosts().has(hostname);
}

/** Native/CLI peers have no Origin. Browsers must come from this server, not another website. */
export function isSameOriginRequest(
  req: IncomingMessage,
  allowedHosts?: Iterable<string>,
): boolean {
  if (!isAllowedHostHeader(req, allowedHosts)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return req.headers['sec-fetch-site'] !== 'cross-site';
  try {
    const url = new URL(origin);
    // The same authority serves HTTP and HTTPS, and development can sit
    // behind a TLS-terminating preview proxy. Do not trust forwarded IPs.
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host.toLowerCase() === req.headers.host?.trim().toLowerCase();
  } catch { return false; }
}

export const requestErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  const requested = (error as { status?: unknown } | null)?.status;
  const status = error instanceof URIError ? 400
    : typeof requested === 'number' && requested >= 400 && requested <= 599 ? requested : 500;
  res.status(status).json({ error: status < 500 ? 'Invalid request.' : 'Request failed. Please retry.' });
};
