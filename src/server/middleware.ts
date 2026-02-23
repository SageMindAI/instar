/**
 * Express middleware — JSON parsing, CORS, auth, error handling.
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Restrict CORS to localhost origins only — this is a local management API
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

/**
 * Auth middleware — enforces Bearer token on API endpoints.
 * Health endpoint is exempt (used for external monitoring).
 */
export function authMiddleware(authToken?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth if no token configured
    if (!authToken) {
      next();
      return;
    }

    // Health endpoint is always public
    if (req.path === '/health') {
      next();
      return;
    }

    // Internal endpoints are localhost-only (server binds 127.0.0.1) — skip auth
    if (req.path.startsWith('/internal/')) {
      next();
      return;
    }

    // View routes support signed URLs for browser access (see ?sig= below)
    if (req.path.startsWith('/view/') && req.method === 'GET') {
      const sig = typeof req.query.sig === 'string' ? req.query.sig : null;
      if (sig && verifyViewSignature(req.path, sig, authToken)) {
        next();
        return;
      }
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = header.slice(7);
    // Hash both sides so lengths are always equal — prevents timing leak of token length
    const ha = createHash('sha256').update(token).digest();
    const hb = createHash('sha256').update(authToken).digest();
    if (!timingSafeEqual(ha, hb)) {
      res.status(403).json({ error: 'Invalid auth token' });
      return;
    }

    next();
  };
}

/**
 * Simple in-memory rate limiter using a sliding window.
 * No external dependencies. Suitable for a local management API.
 */
export function rateLimiter(windowMs: number = 60_000, maxRequests: number = 10) {
  const requests = new Map<string, number[]>();

  // Periodic cleanup to prevent unbounded memory growth from unique IPs
  const gcInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of requests.entries()) {
      if (bucket.length === 0 || bucket[bucket.length - 1] <= now - windowMs) {
        requests.delete(key);
      }
    }
  }, windowMs * 2);
  gcInterval.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let bucket = requests.get(key);
    if (!bucket) {
      bucket = [];
      requests.set(key, bucket);
    }

    // Remove expired entries
    while (bucket.length > 0 && bucket[0] <= now - windowMs) {
      bucket.shift();
    }

    if (bucket.length >= maxRequests) {
      res.status(429).json({
        error: `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs / 1000}s.`,
        retryAfterMs: bucket[0] + windowMs - now,
      });
      return;
    }

    bucket.push(now);
    next();
  };
}

/**
 * Request timeout middleware — prevents slow requests from hanging.
 * Returns 408 if the request takes longer than the timeout.
 */
export function requestTimeout(timeoutMs: number = 30_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done && !res.headersSent) {
        res.status(408).json({
          error: 'Request timeout',
          timeoutMs,
        });
      }
    }, timeoutMs);

    // Clear timeout when response finishes
    res.on('finish', () => { done = true; clearTimeout(timer); });
    res.on('close', () => { done = true; clearTimeout(timer); });
    next();
  };
}

/**
 * HMAC-sign a view path so the URL can be opened in a browser without exposing the auth token.
 * The signature is path-specific — sharing a signed URL only grants access to that one view.
 */
export function signViewPath(viewPath: string, authToken: string): string {
  return createHmac('sha256', authToken).update(viewPath).digest('hex');
}

/**
 * Verify a signed view URL. Returns true if the sig matches the path.
 */
function verifyViewSignature(viewPath: string, sig: string, authToken: string): boolean {
  const expected = createHmac('sha256', authToken).update(viewPath).digest();
  const provided = Buffer.from(sig, 'hex');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[server] Error: ${message}`);
  // Never leak internal error details to clients
  res.status(500).json({
    error: 'Internal server error',
    timestamp: new Date().toISOString(),
  });
}
