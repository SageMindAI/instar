import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DNSVerifier } from '../../../src/threadline/DNSVerifier.js';
import type { DNSResolverFn, DNSVerifyResult } from '../../../src/threadline/DNSVerifier.js';

/**
 * DNSVerifier unit tests — validates DNS TXT record verification
 * for Threadline agent identity.
 *
 * Uses injectable DNS resolver to avoid real DNS lookups.
 */

// ── Helpers ───────────────────────────────────────────────────────────

/** Create a mock resolver that returns fixed records for a given hostname */
function createMockResolver(
  records: Record<string, string[][]>,
): DNSResolverFn {
  return async (hostname: string) => {
    const result = records[hostname];
    if (result === undefined) {
      const err = new Error(`queryTxt ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    }
    return result;
  };
}

/** Create a DNS error with a specific code */
function createDNSError(code: string, message?: string): NodeJS.ErrnoException {
  const err = new Error(message ?? `DNS error: ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('DNSVerifier', () => {
  // ── 1. Constructor ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates with default config', () => {
      const verifier = new DNSVerifier();
      expect(verifier).toBeInstanceOf(DNSVerifier);
    });

    it('creates with custom cache TTL', () => {
      const verifier = new DNSVerifier({ cacheTtlMs: 1000 });
      expect(verifier).toBeInstanceOf(DNSVerifier);
    });

    it('creates with custom resolver', () => {
      const resolver: DNSResolverFn = async () => [];
      const verifier = new DNSVerifier({ resolver });
      expect(verifier).toBeInstanceOf(DNSVerifier);
    });

    it('creates with both custom TTL and resolver', () => {
      const resolver: DNSResolverFn = async () => [];
      const verifier = new DNSVerifier({ cacheTtlMs: 30000, resolver });
      expect(verifier).toBeInstanceOf(DNSVerifier);
    });
  });

  // ── 2. Successful Verification ──────────────────────────────────────

  describe('successful verification', () => {
    it('verifies exact fingerprint match', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=abc123def456']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123def456');

      expect(result.verified).toBe(true);
      expect(result.record).toBe('threadline-agent=v1 fp=abc123def456');
      expect(result.reason).toContain('verified');
    });

    it('verifies case-insensitive fingerprint (uppercase expected)', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=abc123def']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'ABC123DEF');

      expect(result.verified).toBe(true);
    });

    it('verifies case-insensitive fingerprint (uppercase in record)', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=ABC123DEF']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123def');

      expect(result.verified).toBe(true);
    });

    it('verifies mixed case fingerprint', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=aAbBcC112233']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'AaBbCc112233');

      expect(result.verified).toBe(true);
    });

    it('finds match among multiple TXT records', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [
          ['v=spf1 include:something.com ~all'],
          ['google-site-verification=xyz'],
          ['threadline-agent=v1 fp=deadbeef'],
        ],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'deadbeef');

      expect(result.verified).toBe(true);
      expect(result.record).toBe('threadline-agent=v1 fp=deadbeef');
    });

    it('includes domain in reason on success', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=aaa111']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'aaa111');

      expect(result.reason).toContain('example.com');
      expect(result.reason).toContain('verified');
    });

    it('handles chunked TXT records (multi-string arrays)', async () => {
      // DNS TXT records can be split into chunks
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 ', 'fp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(true);
      expect(result.record).toBe('threadline-agent=v1 fp=abc123');
    });
  });

  // ── 3. Failed Verification ──────────────────────────────────────────

  describe('failed verification', () => {
    it('fails when no TXT records exist', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('No Threadline TXT record');
    });

    it('fails when TXT records exist but none are threadline records', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [
          ['v=spf1 include:something.com ~all'],
          ['google-site-verification=xyz'],
        ],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('No Threadline TXT record');
    });

    it('fails when fingerprint does not match', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'def456');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('fingerprint does not match');
    });

    it('includes the mismatched record in result on fingerprint mismatch', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'def456');

      expect(result.verified).toBe(false);
      expect(result.record).toBe('threadline-agent=v1 fp=abc123');
    });

    it('fails when multiple threadline records exist but none match', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [
          ['threadline-agent=v1 fp=aaa111'],
          ['threadline-agent=v1 fp=bbb222'],
          ['threadline-agent=v1 fp=ccc333'],
        ],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'ddd444');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('fingerprint does not match');
    });

    it('returns first threadline record when multiple exist and none match', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [
          ['threadline-agent=v1 fp=aaa111'],
          ['threadline-agent=v1 fp=bbb222'],
        ],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'zzz999');

      expect(result.verified).toBe(false);
      expect(result.record).toBe('threadline-agent=v1 fp=aaa111');
    });
  });

  // ── 4. DNS Error Handling ───────────────────────────────────────────

  describe('DNS error handling', () => {
    it('handles ENOTFOUND gracefully', async () => {
      const resolver: DNSResolverFn = async () => {
        throw createDNSError('ENOTFOUND');
      };
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('nonexistent.com', 'abc123');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('No DNS record found');
      expect(result.reason).toContain('ENOTFOUND');
    });

    it('handles ENODATA gracefully', async () => {
      const resolver: DNSResolverFn = async () => {
        throw createDNSError('ENODATA');
      };
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('No DNS record found');
      expect(result.reason).toContain('ENODATA');
    });

    it('handles ETIMEOUT gracefully', async () => {
      const resolver: DNSResolverFn = async () => {
        throw createDNSError('ETIMEOUT');
      };
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('slow.example.com', 'abc123');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('timed out');
      expect(result.reason).toContain('ETIMEOUT');
    });

    it('handles EAI_AGAIN gracefully', async () => {
      const resolver: DNSResolverFn = async () => {
        throw createDNSError('EAI_AGAIN');
      };
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('flaky.example.com', 'abc123');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('timed out');
      expect(result.reason).toContain('EAI_AGAIN');
    });

    it('handles generic DNS errors', async () => {
      const resolver: DNSResolverFn = async () => {
        throw createDNSError('ESERVFAIL', 'Server failure');
      };
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('broken.example.com', 'abc123');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('DNS lookup failed');
      expect(result.reason).toContain('Server failure');
    });

    it('handles non-Error exceptions', async () => {
      const resolver: DNSResolverFn = async () => {
        throw 'string error';
      };
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('DNS lookup failed');
    });

    it('includes hostname in ENOTFOUND error message', async () => {
      const resolver: DNSResolverFn = async () => {
        throw createDNSError('ENOTFOUND');
      };
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('missing.example.com', 'abc123');

      expect(result.reason).toContain('_threadline.missing.example.com');
    });

    it('includes hostname in timeout error message', async () => {
      const resolver: DNSResolverFn = async () => {
        throw createDNSError('ETIMEOUT');
      };
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('slow.example.com', 'abc123');

      expect(result.reason).toContain('_threadline.slow.example.com');
    });
  });

  // ── 5. Caching ──────────────────────────────────────────────────────

  describe('caching', () => {
    it('returns cached result on second call', async () => {
      let callCount = 0;
      const resolver: DNSResolverFn = async () => {
        callCount++;
        return [['threadline-agent=v1 fp=abc123']];
      };
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 60000 });

      const result1 = await verifier.verify('example.com', 'abc123');
      const result2 = await verifier.verify('example.com', 'abc123');

      expect(result1.verified).toBe(true);
      expect(result2.verified).toBe(true);
      expect(callCount).toBe(1); // Only one DNS call
    });

    it('caches failures too', async () => {
      let callCount = 0;
      const resolver: DNSResolverFn = async () => {
        callCount++;
        throw createDNSError('ENOTFOUND');
      };
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 60000 });

      const result1 = await verifier.verify('missing.com', 'abc123');
      const result2 = await verifier.verify('missing.com', 'abc123');

      expect(result1.verified).toBe(false);
      expect(result2.verified).toBe(false);
      expect(callCount).toBe(1);
    });

    it('uses separate cache keys for different domains', async () => {
      let callCount = 0;
      const resolver = createMockResolver({
        '_threadline.a.com': [['threadline-agent=v1 fp=aaa']],
        '_threadline.b.com': [['threadline-agent=v1 fp=bbb']],
      });
      const wrappedResolver: DNSResolverFn = async (hostname) => {
        callCount++;
        return resolver(hostname);
      };
      const verifier = new DNSVerifier({ resolver: wrappedResolver, cacheTtlMs: 60000 });

      await verifier.verify('a.com', 'aaa');
      await verifier.verify('b.com', 'bbb');

      expect(callCount).toBe(2);
    });

    it('uses separate cache keys for different fingerprints on same domain', async () => {
      let callCount = 0;
      const resolver: DNSResolverFn = async () => {
        callCount++;
        return [['threadline-agent=v1 fp=abc123']];
      };
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 60000 });

      await verifier.verify('example.com', 'abc123');
      await verifier.verify('example.com', 'def456');

      expect(callCount).toBe(2);
    });

    it('expires cache entries after TTL', async () => {
      let callCount = 0;
      const resolver: DNSResolverFn = async () => {
        callCount++;
        return [['threadline-agent=v1 fp=abc123']];
      };
      // Very short TTL
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 10 });

      await verifier.verify('example.com', 'abc123');
      expect(callCount).toBe(1);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 20));

      await verifier.verify('example.com', 'abc123');
      expect(callCount).toBe(2);
    });

    it('clearCache removes all entries', async () => {
      let callCount = 0;
      const resolver: DNSResolverFn = async () => {
        callCount++;
        return [['threadline-agent=v1 fp=abc123']];
      };
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 60000 });

      await verifier.verify('example.com', 'abc123');
      expect(callCount).toBe(1);

      verifier.clearCache();

      await verifier.verify('example.com', 'abc123');
      expect(callCount).toBe(2);
    });

    it('clearCache allows different results on re-verification', async () => {
      let returnSuccess = true;
      const resolver: DNSResolverFn = async () => {
        if (returnSuccess) {
          return [['threadline-agent=v1 fp=abc123']];
        }
        throw createDNSError('ENOTFOUND');
      };
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 60000 });

      const result1 = await verifier.verify('example.com', 'abc123');
      expect(result1.verified).toBe(true);

      returnSuccess = false;
      verifier.clearCache();

      const result2 = await verifier.verify('example.com', 'abc123');
      expect(result2.verified).toBe(false);
    });
  });

  // ── 6. Multiple Records ─────────────────────────────────────────────

  describe('multiple records', () => {
    it('finds threadline record among non-threadline records', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [
          ['v=spf1 include:_spf.google.com ~all'],
          ['threadline-agent=v1 fp=beef1234'],
          ['dkim1._domainkey=something'],
        ],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'beef1234');

      expect(result.verified).toBe(true);
    });

    it('matches correct fingerprint among multiple threadline records', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [
          ['threadline-agent=v1 fp=aaa111'],
          ['threadline-agent=v1 fp=bbb222'],
          ['threadline-agent=v1 fp=ccc333'],
        ],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'bbb222');

      expect(result.verified).toBe(true);
      expect(result.record).toBe('threadline-agent=v1 fp=bbb222');
    });

    it('matches last threadline record if that is the match', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [
          ['threadline-agent=v1 fp=aaa111'],
          ['threadline-agent=v1 fp=bbb222'],
          ['threadline-agent=v1 fp=ccc333'],
        ],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'ccc333');

      expect(result.verified).toBe(true);
      expect(result.record).toBe('threadline-agent=v1 fp=ccc333');
    });

    it('ignores non-threadline records when no match found', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [
          ['v=spf1 something'],
          ['threadline-agent=v1 fp=aaa111'],
          ['some-other-record=xyz'],
        ],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'zzz999');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('fingerprint does not match');
      // Should return the threadline record, not the SPF record
      expect(result.record).toBe('threadline-agent=v1 fp=aaa111');
    });
  });

  // ── 7. Edge Cases ───────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty records array', async () => {
      const resolver: DNSResolverFn = async () => [];
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('No Threadline TXT record');
    });

    it('handles records with empty string arrays', async () => {
      const resolver: DNSResolverFn = async () => [['']];
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(false);
    });

    it('rejects malformed threadline record missing fp= prefix', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(false);
    });

    it('rejects threadline record with non-hex fingerprint', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=xyz!@#']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'xyz!@#');

      expect(result.verified).toBe(false);
    });

    it('rejects threadline record with extra fields after fingerprint', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=abc123 extra=stuff']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      // The regex requires the record to end after the fingerprint
      expect(result.verified).toBe(false);
    });

    it('handles threadline-agent=v1 without fingerprint field', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      // Record starts with prefix but regex won't match (no fp=)
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('fingerprint does not match');
    });

    it('handles threadline prefix with wrong version', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v2 fp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      // v2 doesn't start with 'threadline-agent=v1'
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('No Threadline TXT record');
    });

    it('handles subdomain input correctly', async () => {
      const resolver = createMockResolver({
        '_threadline.sub.example.com': [['threadline-agent=v1 fp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('sub.example.com', 'abc123');

      expect(result.verified).toBe(true);
    });

    it('handles record with multiple spaces between fields', async () => {
      // The regex expects \s+ so multiple spaces should work
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1  fp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(true);
    });

    it('handles record with tab between fields', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1\tfp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      expect(result.verified).toBe(true);
    });

    it('rejects record with leading whitespace', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [[' threadline-agent=v1 fp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', 'abc123');

      // startsWith check won't match with leading space
      expect(result.verified).toBe(false);
    });

    it('handles empty fingerprint input', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver });

      const result = await verifier.verify('example.com', '');

      expect(result.verified).toBe(false);
    });
  });

  // ── 8. getCacheSize ─────────────────────────────────────────────────

  describe('getCacheSize', () => {
    it('returns 0 for empty cache', () => {
      const resolver: DNSResolverFn = async () => [];
      const verifier = new DNSVerifier({ resolver });

      expect(verifier.getCacheSize()).toBe(0);
    });

    it('returns correct count after verifications', async () => {
      const resolver = createMockResolver({
        '_threadline.a.com': [['threadline-agent=v1 fp=aaa']],
        '_threadline.b.com': [['threadline-agent=v1 fp=bbb']],
        '_threadline.c.com': [['threadline-agent=v1 fp=ccc']],
      });
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 60000 });

      await verifier.verify('a.com', 'aaa');
      await verifier.verify('b.com', 'bbb');
      await verifier.verify('c.com', 'ccc');

      expect(verifier.getCacheSize()).toBe(3);
    });

    it('returns 0 after clearCache', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=abc']],
      });
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 60000 });

      await verifier.verify('example.com', 'abc');
      expect(verifier.getCacheSize()).toBe(1);

      verifier.clearCache();
      expect(verifier.getCacheSize()).toBe(0);
    });

    it('prunes expired entries when called', async () => {
      const resolver: DNSResolverFn = async () => {
        return [['threadline-agent=v1 fp=abc123']];
      };
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 10 });

      await verifier.verify('example.com', 'abc123');
      expect(verifier.getCacheSize()).toBe(1);

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(verifier.getCacheSize()).toBe(0);
    });

    it('only prunes expired entries, keeps valid ones', async () => {
      let callCount = 0;
      const resolver: DNSResolverFn = async () => {
        callCount++;
        return [['threadline-agent=v1 fp=abc123']];
      };

      // First verifier entry with very short TTL
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 10 });
      await verifier.verify('short.com', 'abc123');

      // Wait for the first to expire, then add another with fresh TTL
      await new Promise(resolve => setTimeout(resolve, 20));

      // This creates a fresh cache entry
      await verifier.verify('fresh.com', 'abc123');

      // getCacheSize should prune the expired 'short.com' entry
      expect(verifier.getCacheSize()).toBe(1);
    });

    it('counts different fingerprint lookups for same domain separately', async () => {
      const resolver = createMockResolver({
        '_threadline.example.com': [['threadline-agent=v1 fp=abc123']],
      });
      const verifier = new DNSVerifier({ resolver, cacheTtlMs: 60000 });

      await verifier.verify('example.com', 'abc123');
      await verifier.verify('example.com', 'def456');

      expect(verifier.getCacheSize()).toBe(2);
    });
  });
});
