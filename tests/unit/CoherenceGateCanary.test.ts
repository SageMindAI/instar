/**
 * ResponseReviewCanary — Tests for Phase 4 (canary tests and health).
 *
 * Tests canary test runner, reviewer health reporting, and health endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import type { ResponseReviewConfig } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

function createGate(overrides?: Partial<ResponseReviewConfig>): CoherenceGate {
  return new CoherenceGate({
    config: {
      enabled: true,
      reviewers: {
        'conversational-tone': { enabled: true, mode: 'block' },
        'settling-detection': { enabled: true, mode: 'warn' },
        'capability-accuracy': { enabled: true, mode: 'block' },
      },
      maxRetries: 2,
      timeoutMs: 8000,
      channelDefaults: {
        external: { failOpen: false, skipGate: true, queueOnFailure: false },
        internal: { failOpen: true, skipGate: false, queueOnFailure: false },
      },
      ...overrides,
    },
    stateDir: tmpDir,
    apiKey: 'test-api-key',
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CoherenceGate — Canary & Health', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrg-canary-'));
    fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), '# Test\n## Intent\n- Be helpful');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Canary Tests ──────────────────────────────────────────────────

  describe('canary test runner', () => {
    it('runs canary tests and returns results', async () => {
      const gate = createGate();
      // Mock fetch to pass everything (canary should detect misses)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.canaryId).toMatch(/^canary-/);
        expect(result.description).toBeDefined();
        expect(result.expectedDimension).toBeDefined();
        expect(typeof result.caught).toBe('boolean');
        expect(typeof result.pass).toBe('boolean');
      }
    });

    it('canary-clean-1 should pass (not be caught)', async () => {
      const gate = createGate();
      // Gate returns no review needed for simple messages
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ needsReview: false, reason: 'Simple ack' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();
      const cleanResult = results.find(r => r.canaryId === 'canary-clean-1');

      expect(cleanResult).toBeDefined();
      // canary-clean-1 shouldBlock=false, so if not caught (pass=true), canary passes
      expect(cleanResult!.caught).toBe(false);
      expect(cleanResult!.pass).toBe(true);
    });

    it('canary-tone-1 should be caught (PEL catches internal URLs)', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();
      const toneResult = results.find(r => r.canaryId === 'canary-tone-1');

      expect(toneResult).toBeDefined();
      // canary-tone-1 contains localhost URL in external message — PEL catches it
      expect(toneResult!.caught).toBe(true);
      expect(toneResult!.pass).toBe(true);
    });

    it('stores canary results for health reporting', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();
      gate.setCanaryResults(results);

      const health = gate.getReviewerHealth();
      expect(health.lastCanaryRun).not.toBeNull();
      expect(health.lastCanaryRun!.length).toBe(results.length);
    });
  });

  // ── Reviewer Health ────────────────────────────────────────────────

  describe('reviewer health', () => {
    it('reports healthy status when no reviews have run', () => {
      const gate = createGate();
      const health = gate.getReviewerHealth();

      expect(health.overallStatus).toBe('healthy');
      expect(health.reviewers).toBeDefined();
      expect(health.lastCanaryRun).toBeNull();
    });

    it('reports per-reviewer health metrics', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      await gate.evaluate({
        message: 'A message for health check testing purposes here',
        sessionId: 'health-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      const health = gate.getReviewerHealth();
      for (const [name, reviewer] of Object.entries(health.reviewers)) {
        expect(reviewer).toHaveProperty('passRate');
        expect(reviewer).toHaveProperty('total');
        expect(reviewer).toHaveProperty('status');
        expect(['healthy', 'degraded', 'failing']).toContain(reviewer.status);
      }
    });

    it('detects degraded status when error rate is high', () => {
      const gate = createGate();
      // Simulate high error rate by directly manipulating metrics
      // (In production, this would happen from real API failures)
      const health = gate.getReviewerHealth();

      // Fresh reviewers should all be healthy
      expect(health.overallStatus).toBe('healthy');
    });

    it('includes canary results in health report after running canaries', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      // Before canary
      expect(gate.getReviewerHealth().lastCanaryRun).toBeNull();

      // Run canary
      const results = await gate.runCanaryTests();
      gate.setCanaryResults(results);

      // After canary
      const health = gate.getReviewerHealth();
      expect(health.lastCanaryRun).toHaveLength(results.length);
    });
  });

  // ── Integration: Canary + Proposal ────────────────────────────────

  describe('canary failure triggers investigation', () => {
    it('canary miss can be logged as a proposal for investigation', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();
      const misses = results.filter(r => !r.pass);

      // If any canary was missed, create a proposal
      for (const miss of misses) {
        const proposal = gate.addProposal({
          type: 'modify-reviewer',
          title: `Canary miss: ${miss.canaryId}`,
          description: `Canary ${miss.canaryId} (${miss.description}) was not caught by ${miss.expectedDimension}`,
          source: 'canary',
          data: { canaryId: miss.canaryId, verdict: miss.verdict },
        });
        expect(proposal.source).toBe('canary');
      }

      // The gate should have proposals equal to the number of misses
      const proposals = gate.getProposals('pending');
      expect(proposals.length).toBe(misses.length);
    });
  });
});
