/**
 * DNSVerifier — DNS TXT record verification for Threadline agent identity.
 *
 * Verifies agent identity by checking DNS TXT records at `_threadline.{domain}`.
 * Expected record format: `threadline-agent=v1 fp={hex-fingerprint}`
 *
 * Features:
 * - Configurable cache TTL (default 5 minutes)
 * - Injectable DNS resolver for testing
 * - Handles timeouts, NXDOMAIN, multiple TXT records
 *
 * Part of Threadline Protocol Phase 6C.
 */

import dns from 'node:dns';

// ── Types ────────────────────────────────────────────────────────────

export interface DNSVerifyResult {
  verified: boolean;
  record?: string;
  reason: string;
}

/** Injectable DNS resolver function for testing */
export type DNSResolverFn = (hostname: string) => Promise<string[][]>;

export interface DNSVerifierConfig {
  /** Cache TTL in milliseconds. Default: 5 minutes */
  cacheTtlMs?: number;
  /** Injectable DNS resolver (for testing). Default: dns.promises.resolveTxt */
  resolver?: DNSResolverFn;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TXT_RECORD_PREFIX = 'threadline-agent=v1';
const FINGERPRINT_REGEX = /^threadline-agent=v1\s+fp=([a-fA-F0-9]+)$/;

// ── Cache Entry ──────────────────────────────────────────────────────

interface CacheEntry {
  result: DNSVerifyResult;
  expiresAt: number;
}

// ── Default resolver ─────────────────────────────────────────────────

const defaultResolver: DNSResolverFn = async (hostname: string) => {
  return dns.promises.resolveTxt(hostname);
};

// ── Implementation ───────────────────────────────────────────────────

export class DNSVerifier {
  private readonly resolver: DNSResolverFn;
  private readonly cacheTtlMs: number;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(config?: DNSVerifierConfig) {
    this.resolver = config?.resolver ?? defaultResolver;
    this.cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Verify that a domain has a Threadline TXT record matching the expected fingerprint.
   *
   * Looks up `_threadline.{domain}` TXT record.
   * Expected format: `threadline-agent=v1 fp={hex-fingerprint}`
   */
  async verify(domain: string, expectedFingerprint: string): Promise<DNSVerifyResult> {
    const cacheKey = `${domain}:${expectedFingerprint}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const hostname = `_threadline.${domain}`;
    let result: DNSVerifyResult;

    try {
      const records = await this.resolver(hostname);

      // DNS TXT records come as arrays of strings (chunked), flatten each record
      const flatRecords = records.map(chunks => chunks.join(''));

      // Find a matching threadline record
      const threadlineRecords = flatRecords.filter(r => r.startsWith(TXT_RECORD_PREFIX));

      if (threadlineRecords.length === 0) {
        result = {
          verified: false,
          reason: `No Threadline TXT record found at ${hostname}`,
        };
      } else {
        // Check each threadline record for matching fingerprint
        let matched = false;
        let matchedRecord: string | undefined;

        for (const record of threadlineRecords) {
          const match = FINGERPRINT_REGEX.exec(record);
          if (match) {
            const recordFingerprint = match[1].toLowerCase();
            if (recordFingerprint === expectedFingerprint.toLowerCase()) {
              matched = true;
              matchedRecord = record;
              break;
            }
          }
        }

        if (matched) {
          result = {
            verified: true,
            record: matchedRecord,
            reason: `Domain ${domain} verified — TXT record fingerprint matches`,
          };
        } else {
          result = {
            verified: false,
            record: threadlineRecords[0],
            reason: `Threadline TXT record found at ${hostname} but fingerprint does not match`,
          };
        }
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;

      if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
        result = {
          verified: false,
          reason: `No DNS record found for ${hostname} (${error.code})`,
        };
      } else if (error.code === 'ETIMEOUT' || error.code === 'EAI_AGAIN') {
        result = {
          verified: false,
          reason: `DNS lookup timed out for ${hostname} (${error.code})`,
        };
      } else {
        result = {
          verified: false,
          reason: `DNS lookup failed for ${hostname}: ${error.message ?? String(err)}`,
        };
      }
    }

    // Cache result
    this.cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    return result;
  }

  /**
   * Clear the DNS verification cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size (for diagnostics).
   */
  getCacheSize(): number {
    // Prune expired entries
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
    return this.cache.size;
  }
}
