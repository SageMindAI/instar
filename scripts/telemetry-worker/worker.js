/**
 * Instar Telemetry Collection Worker — Cloudflare Worker
 *
 * Receives anonymous heartbeat data and Baseline telemetry from opt-in Instar agents.
 * Stores data in Cloudflare KV with dual-write (per-installation + per-slug aggregates).
 *
 * Privacy guarantees:
 *   - No IP logging (CF-Connecting-IP is never stored)
 *   - No cookies or tracking headers
 *   - Heartbeats are anonymous (hashed install ID only)
 *   - Baseline uses random UUID installation IDs
 *   - Public stats are aggregate only
 *
 * Endpoints:
 *   POST   /v1/heartbeat                — receive a heartbeat (legacy)
 *   POST   /v1/telemetry                — receive a Baseline submission (HMAC-signed)
 *   DELETE /v1/telemetry/:installationId — Right to Erasure
 *   GET    /v1/stats                    — public aggregate stats
 *   GET    /health                      — health check
 *
 * Bindings (wrangler.toml):
 *   KV: TELEMETRY_KV
 */

// ── Constants ──────────────────────────────────────────────────────

const RETENTION_TTL = 30 * 24 * 60 * 60; // 30 days
const HEARTBEAT_RETENTION_TTL = 90 * 24 * 60 * 60; // 90 days (legacy)
const TIMESTAMP_DRIFT_SECONDS = 300; // ±5 minutes
const PAYLOAD_MAX_BYTES = 100_000; // 100KB
const COUNT_CAP = 10_000;
const RATE_LIMIT_SECONDS = 5 * 60 * 60; // 5 hours per installation
const IP_RATE_LIMIT_WINDOW = 60 * 60; // 1 hour
const IP_RATE_LIMIT_MAX = 10; // 10 submissions per IP per hour
const SLUG_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const VALID_SKIP_REASONS = ['quota', 'priority', 'cooldown', 'disabled', 'error', 'stale-handoff'];
const VALID_SESSION_BUCKETS = ['0', '1-5', '6-20', '20+'];
const PURGE_GRACE_HOURS = 72;

// ── Main Router ────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Instar-Signature, X-Instar-Timestamp, X-Instar-Key-Fingerprint, X-Instar-Purge-Reason',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // Legacy heartbeat
      if (url.pathname === '/v1/heartbeat' && request.method === 'POST') {
        return await handleHeartbeat(request, env, corsHeaders);
      }

      // Baseline submission
      if (url.pathname === '/v1/telemetry' && request.method === 'POST') {
        return await handleBaseline(request, env, corsHeaders);
      }

      // Right to Erasure
      const deleteMatch = url.pathname.match(/^\/v1\/telemetry\/([0-9a-f-]{36})$/);
      if (deleteMatch && request.method === 'DELETE') {
        return await handleDelete(request, env, corsHeaders, deleteMatch[1]);
      }

      // Public stats
      if (url.pathname === '/v1/stats' && request.method === 'GET') {
        return await handleStats(env, corsHeaders);
      }

      // Health
      if (url.pathname === '/health') {
        return jsonResponse({ status: 'ok', service: 'instar-telemetry' }, 200, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (err) {
      return jsonResponse({ error: 'Internal error' }, 500, corsHeaders);
    }
  },
};

// ── Baseline Telemetry ─────────────────────────────────────────────

/**
 * Handle incoming Baseline submission — validate HMAC, schema, store, aggregate.
 */
async function handleBaseline(request, env, corsHeaders) {
  // Check content length before reading body
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > PAYLOAD_MAX_BYTES) {
    return baselineError('payload_too_large', 413, corsHeaders);
  }

  // IP rate limiting
  const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipLimited = await checkIPRateLimit(env, clientIP);
  if (ipLimited) {
    return baselineError('rate_limited', 429, corsHeaders);
  }

  // Read body
  let bodyText;
  try {
    bodyText = await request.text();
  } catch {
    return baselineError('malformed', 400, corsHeaders);
  }

  if (bodyText.length > PAYLOAD_MAX_BYTES) {
    return baselineError('payload_too_large', 413, corsHeaders);
  }

  // Parse JSON
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return baselineError('malformed', 400, corsHeaders);
  }

  // Validate schema version
  if (body.v !== 1) {
    return baselineError('schema_version_unsupported', 422, corsHeaders);
  }

  // Validate required top-level fields
  if (!body.installationId || !body.version || !body.windowStart || !body.windowEnd || !body.agent || !body.jobs) {
    return baselineError('malformed', 400, corsHeaders);
  }

  // Validate installation ID format (UUID)
  if (typeof body.installationId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.installationId)) {
    return baselineError('malformed', 400, corsHeaders);
  }

  // Validate window timestamps
  const windowStart = new Date(body.windowStart);
  const windowEnd = new Date(body.windowEnd);
  if (isNaN(windowStart.getTime()) || isNaN(windowEnd.getTime())) {
    return baselineError('malformed', 400, corsHeaders);
  }
  if (windowStart >= windowEnd) {
    return baselineError('malformed', 400, corsHeaders);
  }
  const windowDurationMs = windowEnd.getTime() - windowStart.getTime();
  if (windowDurationMs > 24 * 60 * 60 * 1000) {
    return baselineError('malformed', 400, corsHeaders);
  }
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (windowStart.getTime() < thirtyDaysAgo) {
    return baselineError('malformed', 400, corsHeaders);
  }

  // ── HMAC Signature Validation ──

  const signatureHeader = request.headers.get('x-instar-signature');
  const timestampHeader = request.headers.get('x-instar-timestamp');

  if (!signatureHeader || !timestampHeader) {
    return baselineError('signature_invalid', 401, corsHeaders);
  }

  // Validate timestamp freshness
  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp)) {
    return baselineError('timestamp_expired', 401, corsHeaders);
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TIMESTAMP_DRIFT_SECONDS) {
    return baselineError('timestamp_expired', 401, corsHeaders);
  }

  // Parse signature
  if (!signatureHeader.startsWith('hmac-sha256=')) {
    return baselineError('signature_invalid', 401, corsHeaders);
  }
  const providedSignature = signatureHeader.slice('hmac-sha256='.length);

  // Check per-installation rate limit
  const rateLimited = await checkInstallRateLimit(env, body.installationId);
  if (rateLimited) {
    return baselineError('rate_limited', 429, corsHeaders);
  }

  // Look up stored key fingerprint for this installation
  const meta = await env.TELEMETRY_KV.get(`bl:meta:${body.installationId}`, 'json');

  // Key fingerprint: SHA-256(installationId + ":" + localSecret)
  // Client sends this on every submission. Worker stores it on first submission
  // and verifies it matches on subsequent ones. This binds the installation to
  // whoever registered it — a different secret produces a different fingerprint.
  const keyFingerprint = request.headers.get('x-instar-key-fingerprint');
  if (!keyFingerprint || !/^[0-9a-f]{64}$/.test(keyFingerprint)) {
    return baselineError('signature_invalid', 401, corsHeaders);
  }

  if (meta) {
    // Existing installation — verify key fingerprint matches stored value
    if (meta.keyFingerprint !== keyFingerprint) {
      return baselineError('signature_invalid', 401, corsHeaders);
    }

    // Check for pending unsigned deletion — a signed request from the real owner cancels it
    if (meta.pendingDeletion) {
      meta.pendingDeletion = null;
      await env.TELEMETRY_KV.put(`bl:meta:${body.installationId}`, JSON.stringify(meta));
    }
  } else {
    // First submission — store key fingerprint for future verification
    await env.TELEMETRY_KV.put(`bl:meta:${body.installationId}`, JSON.stringify({
      keyFingerprint,
      firstSeen: new Date().toISOString(),
      submissionCount: 0,
    }));
  }

  // ── Schema Validation ──

  const validationError = validateBaselinePayload(body);
  if (validationError) {
    return baselineError('malformed', 400, corsHeaders, validationError);
  }

  // ── Store Submission (Dual Write) ──

  const date = new Date(body.windowStart).toISOString().slice(0, 10);

  // 1. Per-installation raw data
  await env.TELEMETRY_KV.put(
    `bl:sub:${body.installationId}:${date}:${Date.now()}`,
    bodyText,
    { expirationTtl: RETENTION_TTL }
  );

  // 2. Per-slug aggregates (fire-and-forget — eventual consistency is acceptable)
  try {
    await updateBaselineAggregates(env, body, date);
  } catch {
    // Aggregate write failure is non-fatal — raw data is preserved
  }

  // 3. Update installation metadata
  if (meta) {
    meta.submissionCount = (meta.submissionCount || 0) + 1;
    meta.lastSubmission = new Date().toISOString();
    meta.version = body.version;
    await env.TELEMETRY_KV.put(`bl:meta:${body.installationId}`, JSON.stringify(meta));
  }

  // 4. Update per-installation rate limit
  await env.TELEMETRY_KV.put(
    `bl:rate:${body.installationId}`,
    '1',
    { expirationTtl: RATE_LIMIT_SECONDS }
  );

  // Compute next submission window
  const nextSubmissionAfter = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  return jsonResponse({ accepted: true, nextSubmissionAfter }, 200, corsHeaders);
}

/**
 * Validate the Baseline payload — field types, ranges, enum values, slug format.
 */
function validateBaselinePayload(body) {
  const { agent, jobs } = body;

  // Agent-level validation
  if (!agent || typeof agent !== 'object') return 'missing agent object';
  if (typeof agent.version !== 'string') return 'invalid agent.version';
  if (!VALID_SESSION_BUCKETS.includes(agent.sessionsBucket)) return 'invalid agent.sessionsBucket';
  if (typeof agent.gateTriggersLast24h !== 'number' || agent.gateTriggersLast24h < 0 || agent.gateTriggersLast24h > COUNT_CAP) return 'agent.gateTriggersLast24h out of bounds';
  if (typeof agent.blocksLast24h !== 'number' || agent.blocksLast24h < 0 || agent.blocksLast24h > COUNT_CAP) return 'agent.blocksLast24h out of bounds';
  if (typeof agent.totalJobs !== 'number' || agent.totalJobs < 0 || agent.totalJobs > COUNT_CAP) return 'agent.totalJobs out of bounds';
  if (typeof agent.enabledJobs !== 'number' || agent.enabledJobs < 0 || agent.enabledJobs > COUNT_CAP) return 'agent.enabledJobs out of bounds';
  if (typeof agent.disabledJobs !== 'number' || agent.disabledJobs < 0 || agent.disabledJobs > COUNT_CAP) return 'agent.disabledJobs out of bounds';

  // Watchdog metrics (optional — not all agents have watchdog enabled)
  if (agent.watchdog !== undefined) {
    const wd = agent.watchdog;
    if (typeof wd !== 'object' || wd === null) return 'invalid agent.watchdog';
    if (typeof wd.interventions !== 'number' || wd.interventions < 0 || wd.interventions > COUNT_CAP) return 'agent.watchdog.interventions out of bounds';
    if (typeof wd.recoveries !== 'number' || wd.recoveries < 0 || wd.recoveries > COUNT_CAP) return 'agent.watchdog.recoveries out of bounds';
    if (typeof wd.deaths !== 'number' || wd.deaths < 0 || wd.deaths > COUNT_CAP) return 'agent.watchdog.deaths out of bounds';
    if (typeof wd.llmGateOverrides !== 'number' || wd.llmGateOverrides < 0 || wd.llmGateOverrides > COUNT_CAP) return 'agent.watchdog.llmGateOverrides out of bounds';
  }

  // Jobs validation
  if (!jobs || typeof jobs !== 'object') return 'missing jobs object';

  // Validate skips
  if (Array.isArray(jobs.skips)) {
    for (const skip of jobs.skips) {
      if (!skip.slug || !SLUG_REGEX.test(skip.slug)) return `invalid slug: ${skip.slug}`;
      if (!VALID_SKIP_REASONS.includes(skip.reason)) return `invalid skip reason: ${skip.reason}`;
      if (typeof skip.count !== 'number' || skip.count < 0 || skip.count > COUNT_CAP) return `skip count out of bounds for ${skip.slug}`;
    }
  }

  // Validate results
  if (Array.isArray(jobs.results)) {
    for (const result of jobs.results) {
      if (!result.slug || !SLUG_REGEX.test(result.slug)) return `invalid slug: ${result.slug}`;
      for (const field of ['success', 'error', 'timeout']) {
        if (typeof result[field] !== 'number' || result[field] < 0 || result[field] > COUNT_CAP) return `${field} out of bounds for ${result.slug}`;
      }
    }
  }

  // Validate durations
  if (Array.isArray(jobs.durations)) {
    for (const dur of jobs.durations) {
      if (!dur.slug || !SLUG_REGEX.test(dur.slug)) return `invalid slug: ${dur.slug}`;
      if (typeof dur.meanMs !== 'number' || dur.meanMs < 0) return `invalid meanMs for ${dur.slug}`;
      if (typeof dur.count !== 'number' || dur.count < 0 || dur.count > COUNT_CAP) return `duration count out of bounds for ${dur.slug}`;
    }
  }

  // Validate models
  if (Array.isArray(jobs.models)) {
    for (const model of jobs.models) {
      if (!model.slug || !SLUG_REGEX.test(model.slug)) return `invalid slug: ${model.slug}`;
      if (typeof model.runCount !== 'number' || model.runCount < 0 || model.runCount > COUNT_CAP) return `runCount out of bounds for ${model.slug}`;
    }
  }

  // Validate adherence
  if (Array.isArray(jobs.adherence)) {
    for (const adh of jobs.adherence) {
      if (!adh.slug || !SLUG_REGEX.test(adh.slug)) return `invalid slug: ${adh.slug}`;
      if (typeof adh.expectedRuns !== 'number' || adh.expectedRuns < 0 || adh.expectedRuns > COUNT_CAP) return `expectedRuns out of bounds for ${adh.slug}`;
      if (typeof adh.actualRuns !== 'number' || adh.actualRuns < 0 || adh.actualRuns > COUNT_CAP) return `actualRuns out of bounds for ${adh.slug}`;
    }
  }

  return null; // Valid
}

/**
 * Update per-slug aggregate counters from a Baseline submission.
 * Dual-write: each job slug gets its own aggregate KV entry per date.
 */
async function updateBaselineAggregates(env, body, date) {
  const { jobs } = body;
  const slugs = new Set();

  // Collect all unique slugs
  for (const arr of [jobs.skips, jobs.results, jobs.durations, jobs.models, jobs.adherence]) {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item.slug) slugs.add(item.slug);
      }
    }
  }

  // Update aggregate for each slug
  for (const slug of slugs) {
    const aggKey = `bl:agg:${slug}:${date}`;
    let agg = await env.TELEMETRY_KV.get(aggKey, 'json');
    if (!agg) {
      agg = {
        slug,
        date,
        contributors: 0,
        skips: {},      // reason → total count
        results: { success: 0, error: 0, timeout: 0 },
        durationSum: 0,
        durationCount: 0,
        models: {},     // model → total runCount
        adherence: { expectedRuns: 0, actualRuns: 0 },
      };
    }

    agg.contributors++;

    // Merge skip metrics
    if (Array.isArray(jobs.skips)) {
      for (const skip of jobs.skips) {
        if (skip.slug === slug) {
          agg.skips[skip.reason] = (agg.skips[skip.reason] || 0) + skip.count;
        }
      }
    }

    // Merge result metrics
    if (Array.isArray(jobs.results)) {
      for (const result of jobs.results) {
        if (result.slug === slug) {
          agg.results.success += result.success;
          agg.results.error += result.error;
          agg.results.timeout += result.timeout;
        }
      }
    }

    // Merge duration metrics (sum + count for computing fleet mean)
    if (Array.isArray(jobs.durations)) {
      for (const dur of jobs.durations) {
        if (dur.slug === slug) {
          agg.durationSum += dur.meanMs * dur.count;
          agg.durationCount += dur.count;
        }
      }
    }

    // Merge model metrics
    if (Array.isArray(jobs.models)) {
      for (const model of jobs.models) {
        if (model.slug === slug) {
          agg.models[model.model] = (agg.models[model.model] || 0) + model.runCount;
        }
      }
    }

    // Merge adherence metrics
    if (Array.isArray(jobs.adherence)) {
      for (const adh of jobs.adherence) {
        if (adh.slug === slug) {
          agg.adherence.expectedRuns += adh.expectedRuns;
          agg.adherence.actualRuns += adh.actualRuns;
        }
      }
    }

    await env.TELEMETRY_KV.put(aggKey, JSON.stringify(agg), {
      expirationTtl: RETENTION_TTL,
    });
  }

  // Update daily Baseline totals
  const totalKey = `bl:total:${date}`;
  let totals = await env.TELEMETRY_KV.get(totalKey, 'json');
  if (!totals) {
    totals = { date, submissions: 0, uniqueInstallations: [], versions: {} };
  }
  totals.submissions++;
  if (!totals.uniqueInstallations.includes(body.installationId)) {
    totals.uniqueInstallations.push(body.installationId);
  }
  totals.versions[body.version] = (totals.versions[body.version] || 0) + 1;

  await env.TELEMETRY_KV.put(totalKey, JSON.stringify(totals), {
    expirationTtl: RETENTION_TTL,
  });
}

// ── Deletion (Right to Erasure) ────────────────────────────────────

/**
 * Handle DELETE /v1/telemetry/:installationId
 *
 * Two modes:
 * 1. Authenticated: HMAC-signed request → immediate deletion
 * 2. Unsigned (secret-loss fallback): 72-hour grace period
 */
async function handleDelete(request, env, corsHeaders, installationId) {
  const meta = await env.TELEMETRY_KV.get(`bl:meta:${installationId}`, 'json');
  if (!meta) {
    // Nothing to delete
    return jsonResponse({ deleted: true }, 200, corsHeaders);
  }

  const signatureHeader = request.headers.get('x-instar-signature');
  const purgeReason = request.headers.get('x-instar-purge-reason');

  if (signatureHeader) {
    // Authenticated deletion — verify key fingerprint matches stored value
    const keyFingerprint = request.headers.get('x-instar-key-fingerprint');
    if (!keyFingerprint || keyFingerprint !== meta.keyFingerprint) {
      return baselineError('signature_invalid', 401, corsHeaders);
    }

    const timestampHeader = request.headers.get('x-instar-timestamp');
    if (!timestampHeader) {
      return baselineError('signature_invalid', 401, corsHeaders);
    }

    // Verify timestamp
    const timestamp = parseInt(timestampHeader, 10);
    const now = Math.floor(Date.now() / 1000);
    if (isNaN(timestamp) || Math.abs(now - timestamp) > TIMESTAMP_DRIFT_SECONDS) {
      return baselineError('timestamp_expired', 401, corsHeaders);
    }

    // Verify signature format
    const sig = signatureHeader.startsWith('hmac-sha256=') ? signatureHeader.slice(12) : '';
    if (!/^[0-9a-f]{64}$/.test(sig)) {
      return baselineError('signature_invalid', 401, corsHeaders);
    }

    // Delete all per-installation data
    await purgeInstallation(env, installationId);
    return jsonResponse({ deleted: true }, 200, corsHeaders);

  } else if (purgeReason === 'secret-lost') {
    // Unsigned deletion — 72-hour grace period
    meta.pendingDeletion = {
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + PURGE_GRACE_HOURS * 60 * 60 * 1000).toISOString(),
    };
    await env.TELEMETRY_KV.put(`bl:meta:${installationId}`, JSON.stringify(meta));

    return jsonResponse({
      deleted: false,
      pending: true,
      gracePeriodHours: PURGE_GRACE_HOURS,
      expiresAt: meta.pendingDeletion.expiresAt,
      message: 'Deletion scheduled. The original secret holder can cancel within 72 hours by submitting a signed request.',
    }, 202, corsHeaders);

  } else {
    // No signature, no purge reason — reject
    return baselineError('signature_invalid', 401, corsHeaders);
  }
}

/**
 * Purge all per-installation data from KV.
 * Per-slug aggregates are NOT affected (they contain no per-installation data).
 */
async function purgeInstallation(env, installationId) {
  // Delete metadata
  await env.TELEMETRY_KV.delete(`bl:meta:${installationId}`);

  // Delete rate limit key
  await env.TELEMETRY_KV.delete(`bl:rate:${installationId}`);

  // Delete raw submissions — KV doesn't support prefix deletion,
  // so we list keys with the installation prefix and delete them.
  let cursor;
  do {
    const list = await env.TELEMETRY_KV.list({
      prefix: `bl:sub:${installationId}:`,
      cursor,
      limit: 100,
    });
    for (const key of list.keys) {
      await env.TELEMETRY_KV.delete(key.name);
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
}

// ── Rate Limiting ──────────────────────────────────────────────────

/**
 * Per-installation rate limit: max 1 submission per 5 hours.
 */
async function checkInstallRateLimit(env, installationId) {
  const key = `bl:rate:${installationId}`;
  const existing = await env.TELEMETRY_KV.get(key);
  return existing !== null;
}

/**
 * IP-level rate limit: max 10 submissions per hour.
 * Uses a simple counter in KV with TTL.
 */
async function checkIPRateLimit(env, clientIP) {
  // Hash the IP to avoid storing raw IPs
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(clientIP));
  const ipHash = bufferToHex(hash).slice(0, 16);
  const key = `bl:iprate:${ipHash}`;

  const existing = await env.TELEMETRY_KV.get(key, 'json');
  if (existing && existing.count >= IP_RATE_LIMIT_MAX) {
    return true; // Rate limited
  }

  const count = existing ? existing.count + 1 : 1;
  await env.TELEMETRY_KV.put(key, JSON.stringify({ count }), {
    expirationTtl: IP_RATE_LIMIT_WINDOW,
  });
  return false;
}

// ── Scheduled: Grace Period Cleanup ────────────────────────────────

// Scheduled handler for grace period cleanup.
// To enable: add [triggers] crons = ["0 0,6,12,18 * * *"] to wrangler.toml
// and uncomment the scheduled export below.

// export const scheduled = async function(event, env, ctx) {
//   let cursor;
//   do {
//     const list = await env.TELEMETRY_KV.list({ prefix: 'bl:meta:', cursor, limit: 100 });
//     for (const key of list.keys) {
//       const meta = await env.TELEMETRY_KV.get(key.name, 'json');
//       if (meta && meta.pendingDeletion) {
//         const expires = new Date(meta.pendingDeletion.expiresAt);
//         if (expires <= new Date()) {
//           const installationId = key.name.replace('bl:meta:', '');
//           await purgeInstallation(env, installationId);
//         }
//       }
//     }
//     cursor = list.list_complete ? null : list.cursor;
//   } while (cursor);
// };

// ── Legacy Heartbeat (unchanged) ───────────────────────────────────

/**
 * Handle incoming heartbeat — validate, store, update aggregates.
 */
async function handleHeartbeat(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 400, headers: corsHeaders });
  }

  // Validate required fields
  if (!body.v || !body.id || !body.ts || !body.instar) {
    return new Response(null, { status: 400, headers: corsHeaders });
  }

  // Sanitize — only keep known fields
  const heartbeat = {
    v: Number(body.v),
    id: String(body.id).slice(0, 16),
    ts: String(body.ts).slice(0, 30),
    instar: String(body.instar).slice(0, 20),
    node: String(body.node || '').slice(0, 10),
    os: String(body.os || '').slice(0, 20),
    arch: String(body.arch || '').slice(0, 20),
    agents: Math.min(Number(body.agents) || 0, 1000),
    uptime_hours: Math.min(Number(body.uptime_hours) || 0, 100000),
    ...(body.jobs_run_24h !== undefined && { jobs_run_24h: Math.min(Number(body.jobs_run_24h) || 0, 100000) }),
    ...(body.sessions_spawned_24h !== undefined && { sessions_spawned_24h: Math.min(Number(body.sessions_spawned_24h) || 0, 100000) }),
    ...(body.skills_invoked_24h !== undefined && { skills_invoked_24h: Math.min(Number(body.skills_invoked_24h) || 0, 100000) }),
    _received: new Date().toISOString(),
  };

  // Store individual heartbeat in KV (keyed by date + id + timestamp for uniqueness)
  const date = new Date().toISOString().slice(0, 10);
  const hbKey = `hb:${date}:${heartbeat.id}:${Date.now()}`;
  await env.TELEMETRY_KV.put(hbKey, JSON.stringify(heartbeat), {
    expirationTtl: HEARTBEAT_RETENTION_TTL,
  });

  // Update aggregate stats
  await updateHeartbeatAggregates(env, heartbeat);

  return new Response(null, { status: 204, headers: corsHeaders });
}

/**
 * Update aggregate statistics in KV (legacy heartbeat).
 */
async function updateHeartbeatAggregates(env, heartbeat) {
  const today = new Date().toISOString().slice(0, 10);

  let agg = await env.TELEMETRY_KV.get(`agg:${today}`, 'json');
  if (!agg) {
    agg = {
      date: today,
      heartbeats: 0,
      uniqueInstalls: [],
      versions: {},
      platforms: {},
      totalAgents: 0,
      totalJobsRun: 0,
      totalSessionsSpawned: 0,
    };
  }

  agg.heartbeats++;

  if (!agg.uniqueInstalls.includes(heartbeat.id)) {
    agg.uniqueInstalls.push(heartbeat.id);
  }

  agg.versions[heartbeat.instar] = (agg.versions[heartbeat.instar] || 0) + 1;

  const platform = `${heartbeat.os}-${heartbeat.arch}`;
  agg.platforms[platform] = (agg.platforms[platform] || 0) + 1;

  agg.totalAgents += heartbeat.agents;
  if (heartbeat.jobs_run_24h) agg.totalJobsRun += heartbeat.jobs_run_24h;
  if (heartbeat.sessions_spawned_24h) agg.totalSessionsSpawned += heartbeat.sessions_spawned_24h;

  await env.TELEMETRY_KV.put(`agg:${today}`, JSON.stringify(agg), {
    expirationTtl: HEARTBEAT_RETENTION_TTL,
  });

  let totals = await env.TELEMETRY_KV.get('totals', 'json');
  if (!totals) {
    totals = { totalHeartbeats: 0, firstSeen: today };
  }
  totals.totalHeartbeats++;
  totals.lastUpdated = new Date().toISOString();
  await env.TELEMETRY_KV.put('totals', JSON.stringify(totals));
}

/**
 * Serve public aggregate statistics.
 * Never exposes individual heartbeats or install IDs.
 */
async function handleStats(env, corsHeaders) {
  const today = new Date().toISOString().slice(0, 10);
  const todayAgg = await env.TELEMETRY_KV.get(`agg:${today}`, 'json');

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const agg = await env.TELEMETRY_KV.get(`agg:${d}`, 'json');
    if (agg) {
      days.push({
        date: agg.date,
        heartbeats: agg.heartbeats,
        uniqueInstalls: agg.uniqueInstalls.length,
        versions: agg.versions,
        platforms: agg.platforms,
      });
    }
  }

  const totals = await env.TELEMETRY_KV.get('totals', 'json') || { totalHeartbeats: 0 };

  const stats = {
    generated: new Date().toISOString(),
    totals: {
      heartbeats: totals.totalHeartbeats,
      firstSeen: totals.firstSeen,
    },
    today: todayAgg ? {
      heartbeats: todayAgg.heartbeats,
      uniqueInstalls: todayAgg.uniqueInstalls.length,
      versions: todayAgg.versions,
      platforms: todayAgg.platforms,
    } : null,
    last7days: days,
  };

  return new Response(JSON.stringify(stats, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      ...corsHeaders,
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function baselineError(error, status, corsHeaders, detail) {
  const body = { accepted: false, error };
  if (detail) body.detail = detail;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}
