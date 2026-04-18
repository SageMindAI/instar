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
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

    // Health endpoint is always public (Phase 0 migration: will require auth in future)
    if (req.path === '/health') {
      next();
      return;
    }

    // Ping endpoint is always public (lightweight health check for external monitors)
    if (req.path === '/ping') {
      next();
      return;
    }

    // SSE endpoints handle auth inline (supports both header and query param for EventSource)
    if (req.path === '/jobs/events') {
      next();
      return;
    }

    // Dashboard unlock (PIN → token exchange) is unauthenticated by design
    if (req.path === '/dashboard/unlock' && req.method === 'POST') {
      next();
      return;
    }

    // Message relay endpoints use their own auth (agent tokens / machine-HMAC),
    // not the general API bearer token. Auth is enforced in the route handlers.
    if (req.path === '/messages/relay-agent' || req.path === '/messages/relay-machine') {
      next();
      return;
    }

    // Threadline protocol endpoints use their own auth (relay tokens + Ed25519 signatures).
    // Handshake and health endpoints are unauthenticated by design.
    // Authenticated threadline endpoints enforce Threadline-Relay auth in route handlers.
    if (req.path.startsWith('/threadline/')) {
      next();
      return;
    }

    // Internal endpoints: enforce localhost AND bearer token.
    //
    // Per context-death-pitfall-prevention spec § P0.5 (PR3 fix):
    // /internal/* routes are bearer-token authenticated using the
    // same .instar/config.json#authToken. The prior localhost-only
    // check left a gap: any process on the local machine could flip
    // the stop-gate kill-switch or drive /internal/stop-gate/evaluate
    // without credentials. Drift-correction threat model accepts that
    // a truly adversarial session with token access can still bypass;
    // this closes the casual-process gap.
    //
    // Additionally: reject /internal/* when X-Forwarded-For is set
    // (spec P0.5: advisory defense-in-depth against tunnel
    // misconfiguration; a Cloudflare tunnel accidentally routing
    // internal paths to the LAN should not succeed).
    if (req.path.startsWith('/internal/')) {
      const remote = req.socket.remoteAddress;
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.status(403).json({ error: 'Internal routes are localhost-only' });
        return;
      }
      if (req.headers['x-forwarded-for']) {
        res.status(403).json({ error: 'Internal routes reject X-Forwarded-For requests' });
        return;
      }
      // Fall through to the standard bearer check below.
    }

    // Secret drop routes — the token in the URL IS the auth.
    // GET serves the form, POST receives the submission. Both are user-facing.
    if (req.path.startsWith('/secrets/drop/')) {
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
 *
 * `perPathOverrides` lets specific path prefixes use a longer (or shorter)
 * budget. This exists because some routes are intentionally LLM-backed and
 * need headroom the default 30s doesn't provide — the outbound messaging
 * routes (tone gate review + Telegram Bot API roundtrip) commonly take
 * 30–60s under normal load, and a 408 while the actual send is in flight
 * triggers duplicate-send cascades on the client side.
 *
 * Override matching is by longest-prefix, so a more specific prefix beats a
 * shorter parent if both are registered.
 */
export function requestTimeout(
  defaultMs: number = 30_000,
  perPathOverrides: Record<string, number> = {},
) {
  // Precompute overrides sorted by descending prefix length so longest-match
  // wins without scanning every entry on every request.
  const sortedOverrides = Object.entries(perPathOverrides)
    .sort((a, b) => b[0].length - a[0].length);

  return (req: Request, res: Response, next: NextFunction): void => {
    let timeoutMs = defaultMs;
    for (const [prefix, ms] of sortedOverrides) {
      // Match either exact prefix or prefix followed by '/' so that '/foo'
      // does NOT spuriously match '/foo-bar'. req.path in Express never
      // contains the query string, so no '?' branch is needed.
      if (req.path === prefix || req.path.startsWith(prefix + '/')) {
        timeoutMs = ms;
        break;
      }
    }

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

/**
 * Security headers for dashboard paths — prevents clickjacking, MIME-sniffing,
 * and restricts resource loading to trusted sources.
 */
export function dashboardSecurityHeaders(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/dashboard' || req.path.startsWith('/dashboard/')) {
    res.header('X-Frame-Options', 'DENY');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; connect-src 'self'",
    );
    res.header('Referrer-Policy', 'no-referrer');
  }
  next();
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
