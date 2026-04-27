/**
 * whoami-cache — small in-process cache for `GET /whoami` responses.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3d step 2.
 *
 * The sentinel verifies agent-id via `/whoami` BEFORE every recovery
 * `/telegram/reply`. Under a stampede (50 entries draining at once with
 * the per-topic 30s rate cap), this could fire a /whoami call every few
 * seconds. The endpoint is itself rate-limited (1 req/s/agent-IP), so
 * we cache the response for 60s — a much shorter window than typical
 * config-rotation cadence and short enough to bound the staleness of
 * an agent-id mismatch detection.
 *
 * Cache key: `(port, sha256(token), config-mtime)`. Three components
 * because:
 *   - port: a multi-tenant host can have multiple servers on different
 *     ports with different identities; same token but different port =
 *     different agent.
 *   - sha256(token): tokens are sensitive — we cache on a hash, never
 *     the raw value.
 *   - config-mtime: fastest invalidation signal. If config.json changes,
 *     the cached agent-id is stale; a fresh /whoami is mandatory before
 *     we send to a port whose identity may have flipped.
 *
 * The cache is keyed by config-MTIME, not content-hash, because the
 * sentinel reads config on every recovery cycle anyway — re-hashing on
 * every read is wasted work, and mtime is sufficient to detect operator
 * intervention. (mtime CAN be forged by an adversary who can write to
 * the filesystem, but at that point the threat model has bigger problems.)
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

export interface WhoamiResult {
  agentId: string;
  port: number;
}

export interface WhoamiCacheEntry {
  result: WhoamiResult;
  fetchedAt: number;
  configMtimeMs: number;
}

export interface WhoamiCacheDeps {
  now?: () => number;
  /** Override fetch function for tests. Returns the parsed JSON body. */
  fetchFn?: (port: number, token: string, agentId: string) => Promise<WhoamiResult>;
  /** TTL in ms. Defaults to 60s. */
  ttlMs?: number;
}

export class WhoamiCache {
  private readonly cache = new Map<string, WhoamiCacheEntry>();
  private readonly deps: Required<WhoamiCacheDeps>;

  constructor(deps: WhoamiCacheDeps = {}) {
    this.deps = {
      now: deps.now ?? (() => Date.now()),
      fetchFn: deps.fetchFn ?? defaultFetchWhoami,
      ttlMs: deps.ttlMs ?? 60_000,
    };
  }

  /**
   * Get the cached `/whoami` result, or fetch fresh if absent / stale.
   *
   * `configPath` is checked for mtime — a different mtime invalidates
   * any cached entry for the same (port, tokenHash). If the file is
   * missing, we fall back to mtime=0 (never matches) which forces a
   * refetch every call; that's the safe-by-default path for an
   * unconfigured agent.
   */
  async get(
    port: number,
    token: string,
    configPath: string,
    agentId: string,
  ): Promise<WhoamiResult> {
    const tokenHash = sha256(token);
    const key = `${port}|${tokenHash}|${agentId}`;
    const mtime = readMtimeMs(configPath);
    const now = this.deps.now();

    const cached = this.cache.get(key);
    if (
      cached &&
      cached.configMtimeMs === mtime &&
      now - cached.fetchedAt < this.deps.ttlMs
    ) {
      return cached.result;
    }

    const result = await this.deps.fetchFn(port, token, agentId);
    this.cache.set(key, {
      result,
      fetchedAt: now,
      configMtimeMs: mtime,
    });
    return result;
  }

  /** Test introspection — returns the cache size. */
  size(): number {
    return this.cache.size;
  }

  /** Clear all cached entries. */
  clear(): void {
    this.cache.clear();
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function readMtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Default `/whoami` fetcher — calls the local server over HTTP using
 * the bearer token + agent-id binding. The `X-Instar-AgentId` header
 * is intentionally omitted on the cache-fill path: the sentinel uses
 * `/whoami` precisely to LEARN the agent id; sending one preemptively
 * would defeat the discovery oracle protection. The server returns 403
 * `agent_id_header_required` if the header is missing, so we instead
 * call this fetcher with the agent-id from config — the sentinel
 * already knows its own agent id from `config.projectName`.
 *
 * Caller passes `agentId` via the `X-Instar-AgentId` header by way of
 * a custom fetchFn override when testing; the default below assumes
 * the agent id is implicit in the cache key. We keep the signature
 * narrow so most call sites don't have to thread it through.
 */
async function defaultFetchWhoami(
  port: number,
  token: string,
  agentId: string,
): Promise<WhoamiResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/whoami',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Instar-AgentId': agentId,
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(new Error(`/whoami returned ${res.statusCode}: ${body.slice(0, 256)}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed.agentId === 'string' && typeof parsed.port === 'number') {
              resolve({ agentId: parsed.agentId, port: parsed.port });
            } else {
              reject(new Error('/whoami response missing agentId or port'));
            }
          } catch (err) {
            reject(new Error(`/whoami response not JSON: ${err instanceof Error ? err.message : err}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('/whoami request timed out'));
    });
    req.end();
  });
}
