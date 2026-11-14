import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'node:http';

/** Express 4 does not forward rejected async handlers to its error middleware. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => { void Promise.resolve().then(() => handler(req, res, next)).catch(next); };
}

/** Native/CLI peers have no Origin. Browsers must come from this server, not another website. */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return req.headers['sec-fetch-site'] !== 'cross-site';
  try {
    const url = new URL(origin);
    // The same authority serves HTTP and HTTPS, and development can sit
    // behind a TLS-terminating preview proxy. Do not trust forwarded IPs.
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === req.headers.host?.toLowerCase();
  } catch { return false; }
}

export const requestErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  const requested = (error as { status?: unknown } | null)?.status;
  const status = error instanceof URIError ? 400
    : typeof requested === 'number' && requested >= 400 && requested <= 599 ? requested : 500;
  res.status(status).json({ error: status < 500 ? 'Invalid request.' : 'Request failed. Please retry.' });
};
