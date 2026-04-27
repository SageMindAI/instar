import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TelemetryAuth } from '../../src/monitoring/TelemetryAuth.js';
import { TelemetryHeartbeat } from '../../src/monitoring/TelemetryHeartbeat.js';
import type { TelemetryConfig, BaselineSubmission } from '../../src/core/types.js';

/**
 * Tests for the Baseline telemetry submission flow (TelemetryHeartbeat + TelemetryAuth integration)
 * and worker-side validation rules.
 */

describe('Baseline Submission Flow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createHeartbeat(overrides: Partial<TelemetryConfig> = {}): TelemetryHeartbeat {
    const config: TelemetryConfig = {
      enabled: true,
      level: 'basic',
      ...overrides,
    };
    return new TelemetryHeartbeat(config, tmpDir, '/tmp/test-project', '0.14.0-test');
  }

  describe('sendBaselineSubmission()', () => {
    it('should return false when not enabled', async () => {
      const hb = createHeartbeat({ enabled: false });
      const result = await hb.sendBaselineSubmission();
      expect(result).toBe(false);
    });

    it('should return false when no collector is set', async () => {
      const hb = createHeartbeat();
      // Don't set collector
      const result = await hb.sendBaselineSubmission();
      expect(result).toBe(false);
    });

    it('should return false when not provisioned', async () => {
      const hb = createHeartbeat();
      hb.setCollector({
        collect: () => ({} as BaselineSubmission),
      } as any);
      // Don't provision auth
      const result = await hb.sendBaselineSubmission();
      expect(result).toBe(false);
    });

    it('should include HMAC signature header', async () => {
      const hb = createHeartbeat();
      const auth = hb.getAuth();
      auth.provision();

      let capturedHeaders: Record<string, string> = {};
      const mockCollector = {
        collect: () => ({
          v: 1,
          installationId: auth.getInstallationId(),
          version: '0.14.0-test',
          windowStart: new Date(Date.now() - 6 * 3600000).toISOString(),
          windowEnd: new Date().toISOString(),
          agent: {
            version: '0.14.0-test',
            nodeVersion: '20.0.0',
            os: 'darwin',
            arch: 'arm64',
            uptimeHours: 1,
            totalJobs: 0,
            enabledJobs: 0,
            disabledJobs: 0,
            features: {},
            sessionsBucket: '0' as const,
            gateTriggersLast24h: 0,
            blocksLast24h: 0,
          },
          jobs: { skips: [], results: [], durations: [], models: [], adherence: [] },
        }),
      };
      hb.setCollector(mockCollector as any);

      // Mock fetch to capture headers
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        capturedHeaders = init.headers;
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      });

      try {
        await hb.sendBaselineSubmission();

        expect(capturedHeaders['X-Instar-Signature']).toMatch(/^hmac-sha256=[0-9a-f]{64}$/);
        expect(capturedHeaders['X-Instar-Timestamp']).toMatch(/^\d+$/);
        expect(capturedHeaders['X-Instar-Key-Fingerprint']).toMatch(/^[0-9a-f]{64}$/);
        expect(capturedHeaders['Content-Type']).toBe('application/json');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('should reject payloads exceeding 100KB', async () => {
      const hb = createHeartbeat();
      const auth = hb.getAuth();
      auth.provision();

      // Create a collector that returns a huge payload
      const largePayload: BaselineSubmission = {
        v: 1,
        installationId: auth.getInstallationId()!,
        version: '0.14.0-test',
        windowStart: new Date(Date.now() - 6 * 3600000).toISOString(),
        windowEnd: new Date().toISOString(),
        agent: {
          version: '0.14.0-test',
          nodeVersion: '20.0.0',
          os: 'darwin',
          arch: 'arm64',
          uptimeHours: 1,
          totalJobs: 0,
          enabledJobs: 0,
          disabledJobs: 0,
          features: {},
          sessionsBucket: '0',
          gateTriggersLast24h: 0,
          blocksLast24h: 0,
        },
        jobs: {
          // Generate enough data to exceed 100KB
          skips: Array.from({ length: 2000 }, (_, i) => ({
            slug: `job-${i}-with-a-really-long-slug-name`,
            reason: 'quota' as const,
            count: 999,
          })),
          results: [],
          durations: [],
          models: [],
          adherence: [],
        },
      };
      hb.setCollector({ collect: () => largePayload } as any);

      const result = await hb.sendBaselineSubmission();
      expect(result).toBe(false);
    });

    it('should log submissions to transparency log', async () => {
      const hb = createHeartbeat();
      const auth = hb.getAuth();
      auth.provision();

      const payload: BaselineSubmission = {
        v: 1,
        installationId: auth.getInstallationId()!,
        version: '0.14.0-test',
        windowStart: new Date(Date.now() - 6 * 3600000).toISOString(),
        windowEnd: new Date().toISOString(),
        agent: {
          version: '0.14.0-test', nodeVersion: '20.0.0', os: 'darwin', arch: 'arm64',
          uptimeHours: 1, totalJobs: 0, enabledJobs: 0, disabledJobs: 0,
          features: {}, sessionsBucket: '0', gateTriggersLast24h: 0, blocksLast24h: 0,
        },
        jobs: { skips: [], results: [], durations: [], models: [], adherence: [] },
      };
      hb.setCollector({ collect: () => payload } as any);

      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ accepted: true }), { status: 200 })
      );

      try {
        await hb.sendBaselineSubmission();

        const logFile = path.join(tmpDir, 'telemetry', 'submissions.jsonl');
        expect(fs.existsSync(logFile)).toBe(true);
        const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
        expect(lines.length).toBe(1);

        const entry = JSON.parse(lines[0]);
        expect(entry.endpoint).toBe('v1/telemetry');
        expect(entry.responseStatus).toBe(200);
        // Full payload is logged for transparency
        expect(entry.payload.v).toBe(1);
        expect(entry.payload.installationId).toBe(auth.getInstallationId());
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('should handle network failure gracefully', async () => {
      const hb = createHeartbeat();
      const auth = hb.getAuth();
      auth.provision();

      const payload: BaselineSubmission = {
        v: 1,
        installationId: auth.getInstallationId()!,
        version: '0.14.0-test',
        windowStart: new Date(Date.now() - 6 * 3600000).toISOString(),
        windowEnd: new Date().toISOString(),
        agent: {
          version: '0.14.0-test', nodeVersion: '20.0.0', os: 'darwin', arch: 'arm64',
          uptimeHours: 1, totalJobs: 0, enabledJobs: 0, disabledJobs: 0,
          features: {}, sessionsBucket: '0', gateTriggersLast24h: 0, blocksLast24h: 0,
        },
        jobs: { skips: [], results: [], durations: [], models: [], adherence: [] },
      };
      hb.setCollector({ collect: () => payload } as any);

      // Mock fetch to simulate network failure
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));

      try {
        // Should not throw — telemetry failures are fire-and-forget
        const result = await hb.sendBaselineSubmission();
        expect(result).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe('getBaselineStatus()', () => {
    it('should report unprovisioned state', () => {
      const hb = createHeartbeat();
      const status = hb.getBaselineStatus();

      expect(status.provisioned).toBe(false);
      expect(status.installationIdPrefix).toBeNull();
      expect(status.lastSubmission).toBeNull();
      expect(status.hasCollector).toBe(false);
    });

    it('should report provisioned state', () => {
      const hb = createHeartbeat();
      const auth = hb.getAuth();
      auth.provision();
      hb.setCollector({ collect: () => ({}) } as any);

      const status = hb.getBaselineStatus();

      expect(status.provisioned).toBe(true);
      expect(status.installationIdPrefix).toMatch(/^[0-9a-f]{8}$/);
      expect(status.hasCollector).toBe(true);
    });
  });

  describe('getLatestBaselineSubmission()', () => {
    it('should return null when no submissions exist', () => {
      const hb = createHeartbeat();
      expect(hb.getLatestBaselineSubmission()).toBeNull();
    });

    it('should return the last logged submission', () => {
      const hb = createHeartbeat();

      // Manually write a log entry
      const logDir = path.join(tmpDir, 'telemetry');
      fs.mkdirSync(logDir, { recursive: true });
      const entry = {
        timestamp: new Date().toISOString(),
        payload: { v: 1, installationId: 'test' },
        endpoint: 'v1/telemetry',
        responseStatus: 200,
      };
      fs.writeFileSync(
        path.join(logDir, 'submissions.jsonl'),
        JSON.stringify(entry) + '\n'
      );

      const result = hb.getLatestBaselineSubmission();
      expect(result).toBeDefined();
      expect(result!.responseStatus).toBe(200);
      expect(result!.payload.installationId).toBe('test');
    });
  });

  describe('getBaselineSubmissions()', () => {
    it('should return empty array when no submissions exist', () => {
      const hb = createHeartbeat();
      expect(hb.getBaselineSubmissions()).toEqual([]);
    });

    it('should return entries in reverse chronological order', () => {
      const hb = createHeartbeat();
      const logDir = path.join(tmpDir, 'telemetry');
      fs.mkdirSync(logDir, { recursive: true });

      const entries = [1, 2, 3].map(i => ({
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        payload: { v: 1, installationId: `entry-${i}` },
        endpoint: 'v1/telemetry',
        responseStatus: 200,
      }));
      fs.writeFileSync(
        path.join(logDir, 'submissions.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      const result = hb.getBaselineSubmissions();
      expect(result).toHaveLength(3);
      expect(result[0].payload.installationId).toBe('entry-3');
      expect(result[2].payload.installationId).toBe('entry-1');
    });

    it('should respect limit and offset', () => {
      const hb = createHeartbeat();
      const logDir = path.join(tmpDir, 'telemetry');
      fs.mkdirSync(logDir, { recursive: true });

      const entries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        payload: { v: 1, installationId: `entry-${i}` },
        endpoint: 'v1/telemetry',
        responseStatus: 200,
      }));
      fs.writeFileSync(
        path.join(logDir, 'submissions.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      const result = hb.getBaselineSubmissions(3, 2);
      expect(result).toHaveLength(3);
      // Reversed: 9,8,7,6,5... offset 2 = 7,6,5
      expect(result[0].payload.installationId).toBe('entry-7');
    });
  });
});

describe('Worker Payload Validation (Client-Side Simulation)', () => {
  /**
   * These tests validate that payloads produced by TelemetryCollector
   * meet the worker's schema requirements — without needing the actual worker.
   */

  const VALID_SKIP_REASONS = ['quota', 'priority', 'cooldown', 'disabled', 'error', 'stale-handoff'];
  const VALID_SESSION_BUCKETS = ['0', '1-5', '6-20', '20+'];
  const SLUG_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
  const COUNT_CAP = 10_000;

  function validatePayload(body: BaselineSubmission): string | null {
    if (body.v !== 1) return 'schema_version_unsupported';
    if (!body.installationId || !body.version || !body.windowStart || !body.windowEnd || !body.agent || !body.jobs) {
      return 'missing required fields';
    }
    if (!/^[0-9a-f-]{36}$/.test(body.installationId)) return 'invalid installationId';

    const windowStart = new Date(body.windowStart);
    const windowEnd = new Date(body.windowEnd);
    if (isNaN(windowStart.getTime()) || isNaN(windowEnd.getTime())) return 'invalid window timestamps';
    if (windowStart >= windowEnd) return 'windowStart must be before windowEnd';
    if (windowEnd.getTime() - windowStart.getTime() > 24 * 3600000) return 'window > 24h';

    const { agent, jobs } = body;
    if (!VALID_SESSION_BUCKETS.includes(agent.sessionsBucket)) return 'invalid sessionsBucket';
    if (agent.gateTriggersLast24h < 0 || agent.gateTriggersLast24h > COUNT_CAP) return 'gateTriggersLast24h out of bounds';
    if (agent.blocksLast24h < 0 || agent.blocksLast24h > COUNT_CAP) return 'blocksLast24h out of bounds';
    if (agent.totalJobs < 0 || agent.totalJobs > COUNT_CAP) return 'totalJobs out of bounds';

    for (const skip of jobs.skips) {
      if (!SLUG_REGEX.test(skip.slug)) return `invalid slug: ${skip.slug}`;
      if (!VALID_SKIP_REASONS.includes(skip.reason)) return `invalid skip reason: ${skip.reason}`;
      if (skip.count < 0 || skip.count > COUNT_CAP) return `skip count out of bounds: ${skip.slug}`;
    }

    for (const result of jobs.results) {
      if (!SLUG_REGEX.test(result.slug)) return `invalid slug: ${result.slug}`;
      for (const field of ['success', 'error', 'timeout'] as const) {
        if (result[field] < 0 || result[field] > COUNT_CAP) return `${field} out of bounds: ${result.slug}`;
      }
    }

    for (const dur of jobs.durations) {
      if (!SLUG_REGEX.test(dur.slug)) return `invalid slug: ${dur.slug}`;
      if (dur.meanMs < 0) return `negative meanMs: ${dur.slug}`;
      if (dur.count < 0 || dur.count > COUNT_CAP) return `duration count out of bounds: ${dur.slug}`;
    }

    for (const model of jobs.models) {
      if (!SLUG_REGEX.test(model.slug)) return `invalid slug: ${model.slug}`;
      if (model.runCount < 0 || model.runCount > COUNT_CAP) return `runCount out of bounds: ${model.slug}`;
    }

    for (const adh of jobs.adherence) {
      if (!SLUG_REGEX.test(adh.slug)) return `invalid slug: ${adh.slug}`;
      if (adh.expectedRuns < 0 || adh.expectedRuns > COUNT_CAP) return `expectedRuns out of bounds: ${adh.slug}`;
      if (adh.actualRuns < 0 || adh.actualRuns > COUNT_CAP) return `actualRuns out of bounds: ${adh.slug}`;
    }

    return null;
  }

  it('should produce valid payloads from TelemetryCollector', async () => {
    const { TelemetryCollector } = await import('../../src/monitoring/TelemetryCollector.js');

    const now = new Date();
    const windowStart = new Date(now.getTime() - 6 * 3600000);
    const runs = [
      { runId: 'r1', slug: 'health-check', sessionId: 's1', trigger: 'scheduled', startedAt: now.toISOString(), result: 'success' as const, durationSeconds: 30, model: 'haiku' },
      { runId: 'r2', slug: 'health-check', sessionId: 's2', trigger: 'scheduled', startedAt: now.toISOString(), result: 'failure' as const, durationSeconds: 10, model: 'sonnet' },
    ];

    const collector = new TelemetryCollector({
      skipLedger: {
        getSkips: () => [
          { slug: 'health-check', reason: 'quota', timestamp: now.toISOString(), jobSlug: 'health-check' },
          { slug: 'ci-monitor', reason: 'disabled', timestamp: now.toISOString(), jobSlug: 'ci-monitor' },
        ],
      } as any,
      runHistory: {
        query: () => ({ runs, total: runs.length }),
      } as any,
      getJobs: () => [
        { slug: 'health-check', schedule: '*/30 * * * *', enabled: true, prompt: 'test' } as any,
        { slug: 'ci-monitor', schedule: '0 */4 * * *', enabled: true, prompt: 'test' } as any,
      ],
      version: '0.15.0',
      startTime: Date.now() - 3600000,
      getSessionCount24h: () => 3,
      getConfig: () => ({ threadline: { enabled: true } }),
    });

    const installId = 'abcdef01-2345-6789-abcd-ef0123456789';
    const payload = collector.collect(installId, windowStart, now);

    const error = validatePayload(payload);
    expect(error).toBeNull();
  });

  it('should reject payloads with invalid skip reasons', () => {
    const payload: BaselineSubmission = {
      v: 1,
      installationId: 'abcdef01-2345-6789-abcd-ef0123456789',
      version: '0.15.0',
      windowStart: new Date(Date.now() - 6 * 3600000).toISOString(),
      windowEnd: new Date().toISOString(),
      agent: {
        version: '0.15.0', nodeVersion: '20.0.0', os: 'darwin', arch: 'arm64',
        uptimeHours: 1, totalJobs: 1, enabledJobs: 1, disabledJobs: 0,
        features: {}, sessionsBucket: '0', gateTriggersLast24h: 0, blocksLast24h: 0,
      },
      jobs: {
        skips: [{ slug: 'test-job', reason: 'invalid-reason' as any, count: 1 }],
        results: [], durations: [], models: [], adherence: [],
      },
    };

    const error = validatePayload(payload);
    expect(error).toContain('invalid skip reason');
  });

  it('should reject counts exceeding 10,000', () => {
    const payload: BaselineSubmission = {
      v: 1,
      installationId: 'abcdef01-2345-6789-abcd-ef0123456789',
      version: '0.15.0',
      windowStart: new Date(Date.now() - 6 * 3600000).toISOString(),
      windowEnd: new Date().toISOString(),
      agent: {
        version: '0.15.0', nodeVersion: '20.0.0', os: 'darwin', arch: 'arm64',
        uptimeHours: 1, totalJobs: 15000, enabledJobs: 1, disabledJobs: 0,
        features: {}, sessionsBucket: '0', gateTriggersLast24h: 0, blocksLast24h: 0,
      },
      jobs: { skips: [], results: [], durations: [], models: [], adherence: [] },
    };

    const error = validatePayload(payload);
    expect(error).toContain('totalJobs out of bounds');
  });

  it('should reject invalid session buckets', () => {
    const payload: BaselineSubmission = {
      v: 1,
      installationId: 'abcdef01-2345-6789-abcd-ef0123456789',
      version: '0.15.0',
      windowStart: new Date(Date.now() - 6 * 3600000).toISOString(),
      windowEnd: new Date().toISOString(),
      agent: {
        version: '0.15.0', nodeVersion: '20.0.0', os: 'darwin', arch: 'arm64',
        uptimeHours: 1, totalJobs: 1, enabledJobs: 1, disabledJobs: 0,
        features: {}, sessionsBucket: '50-100' as any, gateTriggersLast24h: 0, blocksLast24h: 0,
      },
      jobs: { skips: [], results: [], durations: [], models: [], adherence: [] },
    };

    const error = validatePayload(payload);
    expect(error).toContain('invalid sessionsBucket');
  });

  it('should reject window durations exceeding 24 hours', () => {
    const payload: BaselineSubmission = {
      v: 1,
      installationId: 'abcdef01-2345-6789-abcd-ef0123456789',
      version: '0.15.0',
      windowStart: new Date(Date.now() - 48 * 3600000).toISOString(), // 48h ago
      windowEnd: new Date().toISOString(),
      agent: {
        version: '0.15.0', nodeVersion: '20.0.0', os: 'darwin', arch: 'arm64',
        uptimeHours: 1, totalJobs: 1, enabledJobs: 1, disabledJobs: 0,
        features: {}, sessionsBucket: '0', gateTriggersLast24h: 0, blocksLast24h: 0,
      },
      jobs: { skips: [], results: [], durations: [], models: [], adherence: [] },
    };

    const error = validatePayload(payload);
    expect(error).toContain('window > 24h');
  });

  it('should reject windowStart >= windowEnd', () => {
    const now = new Date();
    const payload: BaselineSubmission = {
      v: 1,
      installationId: 'abcdef01-2345-6789-abcd-ef0123456789',
      version: '0.15.0',
      windowStart: now.toISOString(),
      windowEnd: new Date(now.getTime() - 1000).toISOString(), // Before start
      agent: {
        version: '0.15.0', nodeVersion: '20.0.0', os: 'darwin', arch: 'arm64',
        uptimeHours: 1, totalJobs: 1, enabledJobs: 1, disabledJobs: 0,
        features: {}, sessionsBucket: '0', gateTriggersLast24h: 0, blocksLast24h: 0,
      },
      jobs: { skips: [], results: [], durations: [], models: [], adherence: [] },
    };

    const error = validatePayload(payload);
    expect(error).toContain('windowStart must be before windowEnd');
  });
});

describe('HMAC Signature Format (Worker Compatibility)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmac-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should match the worker expected format: hmac-sha256=<64hex>', () => {
    const auth = new TelemetryAuth(tmpDir);
    auth.provision();
    const installId = auth.getInstallationId()!;
    const sig = auth.sign(installId, '1234567890', Buffer.from('{}'));

    // Worker expects: "hmac-sha256=" prefix + 64 hex chars
    const header = `hmac-sha256=${sig}`;
    expect(header).toMatch(/^hmac-sha256=[0-9a-f]{64}$/);
  });

  it('should produce consistent signatures for the same input', () => {
    const auth = new TelemetryAuth(tmpDir);
    auth.provision();
    const installId = auth.getInstallationId()!;
    const payload = Buffer.from('{"test":"data"}');
    const ts = '1711234567';

    const sig1 = auth.sign(installId, ts, payload);
    const sig2 = auth.sign(installId, ts, payload);
    expect(sig1).toBe(sig2);
  });

  it('should verify the canonical message: installationId:timestamp:SHA256(body)', () => {
    const auth = new TelemetryAuth(tmpDir);
    auth.provision();
    const installId = auth.getInstallationId()!;

    // Read the secret directly for verification
    const secret = fs.readFileSync(
      path.join(tmpDir, 'telemetry', 'local-secret'), 'utf-8'
    ).trim();

    const payload = '{"v":1,"installationId":"test"}';
    const payloadBytes = Buffer.from(payload, 'utf-8');
    const timestamp = '1711234567';

    // Client signs
    const clientSig = auth.sign(installId, timestamp, payloadBytes);

    // Worker-side verification (simulating handleBaseline in worker.js)
    const payloadHash = createHash('sha256').update(payloadBytes).digest('hex');
    const canonicalMessage = `${installId}:${timestamp}:${payloadHash}`;

    // Worker would compute HMAC from its stored knowledge of the secret
    // In practice, the worker uses the key fingerprint for binding, not the secret directly.
    // But for signature verification, the worker would need the same secret.
    // Since this is client-side testing, we verify the format is correct.
    const serverSig = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(canonicalMessage)
      .digest('hex');

    expect(clientSig).toBe(serverSig);
  });

  it('should use colon delimiters in canonical message (spec: R2-1)', () => {
    // This test explicitly verifies the R2-1 fix from the spec review:
    // canonical message format must use colons as delimiters.
    const auth = new TelemetryAuth(tmpDir);
    auth.provision();
    const installId = auth.getInstallationId()!;
    const secret = fs.readFileSync(
      path.join(tmpDir, 'telemetry', 'local-secret'), 'utf-8'
    ).trim();

    const payload = Buffer.from('test');
    const timestamp = '1234567890';

    const sig = auth.sign(installId, timestamp, payload);

    // Verify with colons
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    const withColons = `${installId}:${timestamp}:${payloadHash}`;
    const expected = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(withColons)
      .digest('hex');
    expect(sig).toBe(expected);

    // Verify that other delimiters would NOT match
    const withDash = `${installId}-${timestamp}-${payloadHash}`;
    const wrong = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(withDash)
      .digest('hex');
    expect(sig).not.toBe(wrong);
  });

  it('key fingerprint should be SHA-256 of installationId:localSecret (spec binding)', () => {
    const auth = new TelemetryAuth(tmpDir);
    auth.provision();
    const installId = auth.getInstallationId()!;
    const secret = fs.readFileSync(
      path.join(tmpDir, 'telemetry', 'local-secret'), 'utf-8'
    ).trim();

    const fp = auth.getKeyFingerprint();

    // Worker stores this on first submission and verifies on subsequent ones
    const expected = createHash('sha256')
      .update(`${installId}:${secret}`)
      .digest('hex');
    expect(fp).toBe(expected);
  });
});
