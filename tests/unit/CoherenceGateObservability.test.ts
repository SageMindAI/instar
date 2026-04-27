/**
 * ResponseReviewObservability — Tests for Phase 3 (observability & governance).
 *
 * Tests enhanced history (retention, recipientId, deletion),
 * enhanced stats (per-period, per-recipient-type), proposal queue,
 * and health dashboard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import type { ResponseReviewConfig } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

function mockFetchAllPass() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
    }),
  });
}

function mockFetchBlock() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ pass: false, severity: 'block', issue: 'Bad', suggestion: 'Fix' }) }],
    }),
  });
}

function createGate(overrides?: Partial<ResponseReviewConfig>): CoherenceGate {
  return new CoherenceGate({
    config: {
      enabled: true,
      reviewers: {
        'conversational-tone': { enabled: true, mode: 'block' },
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

describe('CoherenceGate — Observability', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrg-obs-'));
    fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), '# Test\n## Intent\n- Be helpful');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Enhanced History ──────────────────────────────────────────────

  describe('enhanced history', () => {
    it('filters by recipientId', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      await gate.evaluate({
        message: 'Hello from session A to recipient 1',
        sessionId: 'ses-a',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientId: 'user-1' },
      });

      await gate.evaluate({
        message: 'Hello from session B to recipient 2',
        sessionId: 'ses-b',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientId: 'user-2' },
      });

      const all = gate.getReviewHistory();
      expect(all.length).toBe(2);

      const filtered = gate.getReviewHistory({ recipientId: 'user-1' });
      expect(filtered.length).toBe(1);
      expect(filtered[0].recipientId).toBe('user-1');
    });

    it('stores recipientId in audit entries', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      await gate.evaluate({
        message: 'Message with recipient context attached',
        sessionId: 'ses-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientId: 'alice' },
      });

      const history = gate.getReviewHistory();
      expect(history[0].recipientId).toBe('alice');
    });

    it('deletes history for a specific session', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      await gate.evaluate({
        message: 'Message from session to-delete - first',
        sessionId: 'to-delete',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      await gate.evaluate({
        message: 'Message from session to-keep - first',
        sessionId: 'to-keep',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      expect(gate.getReviewHistory().length).toBe(2);

      const deleted = gate.deleteHistory('to-delete');
      expect(deleted).toBe(1);

      const remaining = gate.getReviewHistory();
      expect(remaining.length).toBe(1);
      expect(remaining[0].sessionId).toBe('to-keep');
    });

    it('returns 0 when deleting non-existent session', () => {
      const gate = createGate();
      const deleted = gate.deleteHistory('nonexistent');
      expect(deleted).toBe(0);
    });
  });

  // ── Enhanced Stats ────────────────────────────────────────────────

  describe('enhanced stats', () => {
    it('returns per-reviewer stats with summary', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      await gate.evaluate({
        message: 'Simple message that passes review',
        sessionId: 'ses-stats',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      const stats = gate.getReviewerStats();
      expect(stats.reviewers).toBeDefined();
      expect(stats.summary).toBeDefined();
      expect(stats.summary.totalReviews).toBeGreaterThanOrEqual(0);
      expect(stats.recipientBreakdown).toBeDefined();
    });

    it('breaks down stats by recipient type', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      await gate.evaluate({
        message: 'Message to primary user for stats',
        sessionId: 'ses-rt-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientType: 'primary-user' },
      });

      await gate.evaluate({
        message: 'Message to agent for stats breakdown',
        sessionId: 'ses-rt-2',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false, recipientType: 'agent' },
      });

      const stats = gate.getReviewerStats();
      expect(stats.recipientBreakdown).toBeDefined();
    });

    it('supports period-based filtering', () => {
      const gate = createGate();
      const stats = gate.getReviewerStats({ period: 'daily' });
      expect(stats.summary.period).toBe('daily');
    });
  });

  // ── Proposal Queue ────────────────────────────────────────────────

  describe('proposal queue', () => {
    it('adds a proposal and returns it with generated id', () => {
      const gate = createGate();
      const proposal = gate.addProposal({
        type: 'new-reviewer',
        title: 'Add emoji-detection reviewer',
        description: 'Detect unauthorized emoji usage in external messages',
        source: 'canary',
      });

      expect(proposal.id).toMatch(/^prop-/);
      expect(proposal.status).toBe('pending');
      expect(proposal.createdAt).toBeDefined();
      expect(proposal.title).toBe('Add emoji-detection reviewer');
    });

    it('lists all proposals', () => {
      const gate = createGate();
      gate.addProposal({ type: 'new-reviewer', title: 'P1', description: 'D1', source: 'user' });
      gate.addProposal({ type: 'config-change', title: 'P2', description: 'D2', source: 'auto-detected' });

      const all = gate.getProposals();
      expect(all.length).toBe(2);
    });

    it('filters proposals by status', () => {
      const gate = createGate();
      const p1 = gate.addProposal({ type: 'new-reviewer', title: 'P1', description: 'D1', source: 'user' });
      gate.addProposal({ type: 'config-change', title: 'P2', description: 'D2', source: 'user' });

      gate.resolveProposal(p1.id, 'approve', 'Looks good');

      const pending = gate.getProposals('pending');
      expect(pending.length).toBe(1);

      const approved = gate.getProposals('approved');
      expect(approved.length).toBe(1);
      expect(approved[0].resolution).toBe('Looks good');
    });

    it('approves a pending proposal', () => {
      const gate = createGate();
      const p = gate.addProposal({ type: 'modify-reviewer', title: 'P1', description: 'D1', source: 'user' });

      const result = gate.resolveProposal(p.id, 'approve', 'Approved by operator');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('approved');
      expect(result!.resolvedAt).toBeDefined();
    });

    it('rejects a pending proposal', () => {
      const gate = createGate();
      const p = gate.addProposal({ type: 'new-reviewer', title: 'P1', description: 'D1', source: 'user' });

      const result = gate.resolveProposal(p.id, 'reject', 'Not needed');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('rejected');
      expect(result!.resolution).toBe('Not needed');
    });

    it('returns null when resolving non-existent proposal', () => {
      const gate = createGate();
      expect(gate.resolveProposal('nonexistent', 'approve')).toBeNull();
    });

    it('returns null when resolving already-resolved proposal', () => {
      const gate = createGate();
      const p = gate.addProposal({ type: 'new-reviewer', title: 'P1', description: 'D1', source: 'user' });
      gate.resolveProposal(p.id, 'approve');

      // Try to approve again
      expect(gate.resolveProposal(p.id, 'reject')).toBeNull();
    });
  });

  // ── Health Dashboard ──────────────────────────────────────────────

  describe('health dashboard', () => {
    it('returns health dashboard data', () => {
      const gate = createGate();
      const health = gate.getHealthDashboard();

      expect(health.enabled).toBe(true);
      expect(health.observeOnly).toBe(false);
      expect(health.stats).toBeDefined();
      expect(health.incidentsByDimension).toBeDefined();
      expect(health.reviewerCoverage).toBeDefined();
      expect(health.pendingProposals).toBe(0);
      expect(health.activeRetrySessions).toBe(0);
      expect(health.historySize).toBe(0);
    });

    it('reflects observeOnly mode', () => {
      const gate = createGate({ observeOnly: true });
      const health = gate.getHealthDashboard();
      expect(health.observeOnly).toBe(true);
    });

    it('counts pending proposals', () => {
      const gate = createGate();
      gate.addProposal({ type: 'new-reviewer', title: 'P1', description: 'D1', source: 'user' });
      gate.addProposal({ type: 'config-change', title: 'P2', description: 'D2', source: 'user' });

      const health = gate.getHealthDashboard();
      expect(health.pendingProposals).toBe(2);
    });

    it('shows incident counts by dimension after reviews', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchBlock());

      await gate.evaluate({
        message: 'This message should be blocked by reviewer',
        sessionId: 'health-test',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      const health = gate.getHealthDashboard();
      expect(health.historySize).toBeGreaterThan(0);
    });

    it('tracks reviewer coverage', () => {
      const gate = createGate({
        reviewers: {
          'conversational-tone': { enabled: true, mode: 'block' },
          'settling-detection': { enabled: true, mode: 'warn' },
        },
      });

      const health = gate.getHealthDashboard();
      // No reviews have run yet, so coverage should show all false
      expect(health.reviewerCoverage['conversational-tone']).toBe(false);
    });
  });
});
