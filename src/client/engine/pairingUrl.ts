/**
 * Builds the URL encoded in the pairing QR code.
 *
 * Format (backwards compatible — older phone apps and browsers only read the
 * host and `pair`):
 *
 *   https://<primary>:<port>/?pair=<CODE>&alt=<ip2>,<ip3>&ca=<pin>
 *
 *  - primary: the address a phone *browser* will open. A laptop cannot know
 *    which of its interfaces faces the phone, so the user may pick it; by
 *    default it is the top-ranked advertised endpoint.
 *  - alt: every other advertised endpoint (same scheme/port). The Android app
 *    ranks primary + alternates by which one is on a network the phone is
 *    attached to (e.g. its own hotspot) and races them, so an unreachable
 *    address can no longer win just because it sorted first.
 *  - ca: base64url SHA-256 of the TLS chain anchor. Scanning the QR then
 *    authenticates the first TLS connection (no trust-on-first-use).
 *
 * Only endpoints the server advertises (= covered by its TLS certificate) are
 * ever used, so the QR, mDNS and certificate SANs stay consistent.
 */

export interface PairingUrlInput {
  pairCode: string;
  /** Advertised endpoints, ranked by the server (welcome / network `lanUrls`). */
  lanUrls: string[];
  /** `window.location.origin` of the page rendering the QR. */
  pageOrigin: string;
  /** `window.location.hostname`. */
  pageHostname: string;
  /** Endpoint the user picked as the primary QR address, if any. */
  preferredUrl?: string | null;
  /** base64url SHA-256 TLS anchor pin from the server. */
  tlsPin?: string | null;
}

export const MAX_QR_ALTERNATES = 5;

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

function parseOrigin(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The endpoint that will be the QR's primary host, or null when none is usable. */
export function choosePrimaryEndpoint(input: Omit<PairingUrlInput, 'pairCode' | 'tlsPin'>): string | null {
  const candidates = uniqueOrigins(input.lanUrls);
  if (input.preferredUrl) {
    const preferred = parseOrigin(input.preferredUrl)?.origin;
    if (preferred && candidates.includes(preferred)) return preferred;
  }
  if (!isLoopbackHostname(input.pageHostname)) {
    // The page was opened over the network (e.g. a phone browser, or the
    // Mac's own browser via its LAN IP / .local name): that origin is known
    // to work for whoever opened it.
    return parseOrigin(input.pageOrigin)?.origin ?? candidates[0] ?? null;
  }
  return candidates[0] ?? null;
}

function uniqueOrigins(urls: string[]): string[] {
  const out: string[] = [];
  for (const url of urls) {
    const origin = parseOrigin(url)?.origin;
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

export function buildPairingUrl(input: PairingUrlInput): string {
  if (!input.pairCode) return '';
  const primary = choosePrimaryEndpoint(input) ?? parseOrigin(input.pageOrigin)?.origin;
  if (!primary) return '';
  const primaryUrl = new URL(primary);
  const alternates = uniqueOrigins(input.lanUrls)
    .map((origin) => new URL(origin))
    .filter(
      (url) =>
        url.origin !== primaryUrl.origin &&
        url.protocol === primaryUrl.protocol &&
        url.port === primaryUrl.port
    )
    .map((url) => url.hostname)
    .slice(0, MAX_QR_ALTERNATES);

  let result = `${primaryUrl.origin}/?pair=${encodeURIComponent(input.pairCode)}`;
  if (alternates.length > 0) result += `&alt=${alternates.map(encodeURIComponent).join(',')}`;
  if (input.tlsPin && primaryUrl.protocol === 'https:' && /^[A-Za-z0-9_-]{43}$/.test(input.tlsPin)) {
    result += `&ca=${input.tlsPin}`;
  }
  return result;
}
