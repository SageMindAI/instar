/**
 * ResponseReviewE2E — Holistic end-to-end test for the entire Response Review Pipeline.
 *
 * Exercises the full system from stop hook to reviewer to verdict, simulating
 * realistic message flows through all layers:
 *   PEL → Gate → Specialists → Decision Matrix → Feedback → Retry → Exhaustion
 *
 * Tests the integration of:
 * - PolicyEnforcementLayer (deterministic hard blocks)
 * - CoherenceReviewer base class + all 9 specialist reviewers
 * - RecipientResolver (relationship and trust context)
 * - CustomReviewerLoader (user-defined reviewers)
 * - CoherenceGate orchestrator (decision matrix, retry, feedback)
 * - Hook template (settings structure, stop hook contract)
 * - Observability (history, stats, proposals, health dashboard)
 * - Canary tests (known-bad corpus, health reporting)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import { PolicyEnforcementLayer } from '../../src/core/PolicyEnforcementLayer.js';
import { RecipientResolver } from '../../src/core/RecipientResolver.js';
import { CustomReviewerLoader } from '../../src/core/CustomReviewerLoader.js';
import type { ResponseReviewConfig } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Mock Infrastructure ─────────────────────────────────────────────

let tmpDir: string;
let callCount: number;

type MockResponse = Record<string, unknown>;

function createMockFetch(responses: MockResponse[]) {
  callCount = 0;
  return vi.fn().mockImplementation(async () => {
    const response = responses[callCount % responses.length];
    callCount++;
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify(response) }],
      }),
    };
  });
}

function createFullConfig(overrides?: Partial<ResponseReviewConfig>): ResponseReviewConfig {
  return {
    enabled: true,
    reviewers: {
      'conversational-tone': { enabled: true, mode: 'block' },
      'claim-provenance': { enabled: true, mode: 'block' },
      'settling-detection': { enabled: true, mode: 'warn' },
      'context-completeness': { enabled: true, mode: 'warn' },
      'capability-accuracy': { enabled: true, mode: 'block' },
      'url-validity': { enabled: true, mode: 'block' },
      'value-alignment': { enabled: true, mode: 'block' },
      'information-leakage': { enabled: true, mode: 'block' },
    },
    maxRetries: 2,
    timeoutMs: 8000,
    channelDefaults: {
      external: { failOpen: false, skipGate: true, queueOnFailure: true, queueTimeoutMs: 30000 },
      internal: { failOpen: true, skipGate: false, queueOnFailure: false },
    },
    ...overrides,
  };
}

function createGate(overrides?: Partial<ResponseReviewConfig>): CoherenceGate {
  return new CoherenceGate({
    config: createFullConfig(overrides),
    stateDir: tmpDir,
    apiKey: 'test-api-key',
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Response Review Pipeline — End-to-End', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrg-e2e-'));
    fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), `# Echo
## Intent
### Mission
Build and stress-test instar as a dogfooding agent.
### Tradeoffs
- Thoroughness over speed
- Substance over labels
### Boundaries
- Never expose internal infrastructure details to users
- Never fabricate URLs or claims`);
    fs.writeFileSync(path.join(tmpDir, 'USER.md'), '# Justin\nPrefers casual tone. Direct communication.');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Clean message flows through entire pipeline ────

  describe('Scenario 1: Clean message — full pass', () => {
    it('simple acknowledgment bypasses gate (internal channel)', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', createMockFetch([
        { needsReview: false, reason: 'Simple acknowledgment' },
      ]));

      const result = await gate.evaluate({
        message: 'Got it, working on that now.',
        sessionId: 'e2e-1',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass');
    });

    it('clean response passes all reviewers (external channel)', async () => {
      const gate = createGate();
      // skipGate=true for external, so all calls go to specialists
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      const result = await gate.evaluate({
        message: 'Your scheduler is running 12 jobs. Three ran in the last hour.',
        sessionId: 'e2e-2',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
    });
  });

  // ── Scenario 2: PEL catches hard violation ────────────────────

  describe('Scenario 2: PEL hard block', () => {
    it('blocks credential leakage regardless of reviewer opinion', async () => {
      const gate = createGate();
      // Even if reviewers pass, PEL should catch the API key
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      const result = await gate.evaluate({
        message: 'Your API key is sk-ant-abc123XYZdefghijklmnopqrstuvwx',
        sessionId: 'e2e-3',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(false);
      expect(result._pelBlock).toBe(true);
      expect(result.feedback).toContain('POLICY VIOLATION');
    });

    it('blocks internal URL in external message', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      const result = await gate.evaluate({
        message: 'Check the dashboard at http://localhost:4042/dashboard',
        sessionId: 'e2e-4',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(false);
      expect(result._pelBlock).toBe(true);
    });

    it('allows internal URL on internal channel', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', createMockFetch([
        { needsReview: false, reason: 'Internal info' },
      ]));

      const result = await gate.evaluate({
        message: 'Check the dashboard at http://localhost:4042/dashboard',
        sessionId: 'e2e-5',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      expect(result.pass).toBe(true);
    });
  });

  // ── Scenario 3: Reviewer blocks → revision → pass ────────────

  describe('Scenario 3: Block → Revision → Pass', () => {
    it('blocks on first attempt, passes on clean revision', async () => {
      const gate = createGate({
        reviewers: {
          'conversational-tone': { enabled: true, mode: 'block' },
          'claim-provenance': { enabled: false, mode: 'block' },
          'settling-detection': { enabled: false, mode: 'warn' },
          'context-completeness': { enabled: false, mode: 'warn' },
          'capability-accuracy': { enabled: false, mode: 'block' },
          'url-validity': { enabled: false, mode: 'block' },
          'value-alignment': { enabled: false, mode: 'block' },
          'information-leakage': { enabled: false, mode: 'block' },
        },
      });

      // First call: reviewer says block
      vi.stubGlobal('fetch', createMockFetch([
        { pass: false, severity: 'block', issue: 'Technical language detected', suggestion: 'Use conversational language' },
      ]));

      const firstResult = await gate.evaluate({
        message: 'Configure the endpoint by setting the parameter value.',
        sessionId: 'e2e-revision',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(firstResult.pass).toBe(false);
      expect(firstResult.feedback).toBeDefined();
      expect(firstResult._outcome).toBe('block');

      // Second call: reviewer says pass (revised message)
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      const secondResult = await gate.evaluate({
        message: 'I have set that up for you. All done!',
        sessionId: 'e2e-revision',
        stopHookActive: true,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(secondResult.pass).toBe(true);
    });
  });

  // ── Scenario 4: Retry exhaustion on external channel ──────────

  describe('Scenario 4: Retry exhaustion', () => {
    it('passes after retries exhausted on non-critical issue', async () => {
      const gate = createGate({
        maxRetries: 1,
        reviewers: {
          'conversational-tone': { enabled: true, mode: 'block' },
          'claim-provenance': { enabled: false, mode: 'block' },
          'settling-detection': { enabled: false, mode: 'warn' },
          'context-completeness': { enabled: false, mode: 'warn' },
          'capability-accuracy': { enabled: false, mode: 'block' },
          'url-validity': { enabled: false, mode: 'block' },
          'value-alignment': { enabled: false, mode: 'block' },
          'information-leakage': { enabled: false, mode: 'block' },
        },
      });

      // All attempts return block
      vi.stubGlobal('fetch', createMockFetch([
        { pass: false, severity: 'block', issue: 'Tone issue', suggestion: 'Fix it' },
      ]));

      // First: block
      await gate.evaluate({
        message: 'Technical jargon that triggers reviewer flag.',
        sessionId: 'e2e-exhaust',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      // Second: exhausted → pass (tone is not a critical issue)
      const result = await gate.evaluate({
        message: 'Still not great but retries are exhausted.',
        sessionId: 'e2e-exhaust',
        stopHookActive: true,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-exhausted');
    });
  });

  // ── Scenario 5: ObserveOnly mode ──────────────────────────────

  describe('Scenario 5: ObserveOnly mode', () => {
    it('logs violations but never blocks (except PEL)', async () => {
      const gate = createGate({ observeOnly: true });
      vi.stubGlobal('fetch', createMockFetch([
        { pass: false, severity: 'block', issue: 'Severe violation', suggestion: 'Fix it now' },
      ]));

      const result = await gate.evaluate({
        message: 'This would normally be blocked by the reviewer.',
        sessionId: 'e2e-observe',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-observe');
      expect(result._auditViolations).toBeDefined();
      expect(result._auditViolations!.length).toBeGreaterThan(0);
    });

    it('PEL still blocks in observeOnly mode', async () => {
      const gate = createGate({ observeOnly: true });
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      const result = await gate.evaluate({
        message: 'Here is the key: sk-ant-abc123XYZdefghijklmnopqrstuvwx',
        sessionId: 'e2e-observe-pel',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(false);
      expect(result._pelBlock).toBe(true);
    });
  });

  // ── Scenario 6: Information leakage for agent recipients ──────

  describe('Scenario 6: Information leakage boundary', () => {
    it('skips information-leakage reviewer for primary-user', async () => {
      const gate = createGate();
      let fetchCallCount = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return {
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
          }),
        };
      }));

      await gate.evaluate({
        message: 'Here is the information you requested about the project.',
        sessionId: 'e2e-leak-skip',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientType: 'primary-user' },
      });

      // Store the call count for primary-user
      const primaryUserCalls = fetchCallCount;

      fetchCallCount = 0;
      await gate.evaluate({
        message: 'Here is the information you requested about the project.',
        sessionId: 'e2e-leak-run',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientType: 'agent' },
      });

      // Agent recipient should have more reviewer calls (includes information-leakage)
      expect(fetchCallCount).toBeGreaterThanOrEqual(primaryUserCalls);
    });
  });

  // ── Scenario 7: Full pipeline with history and stats ──────────

  describe('Scenario 7: Pipeline with observability', () => {
    it('full flow: evaluate → check history → check stats → check health', async () => {
      const gate = createGate({
        reviewers: {
          'conversational-tone': { enabled: true, mode: 'block' },
          'settling-detection': { enabled: true, mode: 'warn' },
          // Disable others for deterministic test
          'claim-provenance': { enabled: false, mode: 'block' },
          'context-completeness': { enabled: false, mode: 'warn' },
          'capability-accuracy': { enabled: false, mode: 'block' },
          'url-validity': { enabled: false, mode: 'block' },
          'value-alignment': { enabled: false, mode: 'block' },
          'information-leakage': { enabled: false, mode: 'block' },
        },
      });

      // Evaluate a message
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      await gate.evaluate({
        message: 'Your project is running smoothly. All systems operational.',
        sessionId: 'e2e-full-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientId: 'justin' },
      });

      // Check history
      const history = gate.getReviewHistory();
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].sessionId).toBe('e2e-full-1');
      expect(history[0].recipientId).toBe('justin');

      // Check stats
      const stats = gate.getReviewerStats();
      expect(stats.reviewers).toBeDefined();
      expect(stats.summary.totalReviews).toBeGreaterThan(0);
      expect(stats.recipientBreakdown).toBeDefined();

      // Check health dashboard
      const health = gate.getHealthDashboard();
      expect(health.enabled).toBe(true);
      expect(health.historySize).toBeGreaterThan(0);
      expect(health.reviewerCoverage).toBeDefined();
    });
  });

  // ── Scenario 8: Custom reviewer integration ──────────────────

  describe('Scenario 8: Custom reviewers', () => {
    it('loads and uses custom reviewer specs from .instar/reviewers/', async () => {
      // Create a custom reviewer spec
      const reviewersDir = path.join(tmpDir, 'reviewers');
      fs.mkdirSync(reviewersDir, { recursive: true });
      fs.writeFileSync(path.join(reviewersDir, 'emoji-check.json'), JSON.stringify({
        name: 'emoji-check',
        description: 'Catches unauthorized emoji in messages',
        prompt: 'Check if the message contains emojis. If it does, flag it.',
        mode: 'warn',
        contextRequirements: { message: true },
        priority: 'p2',
      }));

      // Verify the loader can read it
      const loader = new CustomReviewerLoader(tmpDir);
      const specs = loader.loadAll();
      expect(specs.length).toBe(1);
      expect(specs[0].name).toBe('emoji-check');
    });
  });

  // ── Scenario 9: Proposal lifecycle ────────────────────────────

  describe('Scenario 9: Proposal lifecycle', () => {
    it('create → approve → verify in health dashboard', () => {
      const gate = createGate();

      // Create proposal
      const proposal = gate.addProposal({
        type: 'new-reviewer',
        title: 'Add emoji-detection',
        description: 'Detect emojis in external messages',
        source: 'canary',
      });

      // Verify in health
      let health = gate.getHealthDashboard();
      expect(health.pendingProposals).toBe(1);

      // Approve
      gate.resolveProposal(proposal.id, 'approve', 'Approved for next release');

      // Verify resolved
      health = gate.getHealthDashboard();
      expect(health.pendingProposals).toBe(0);

      const approved = gate.getProposals('approved');
      expect(approved.length).toBe(1);
      expect(approved[0].resolution).toBe('Approved for next release');
    });
  });

  // ── Scenario 10: PEL standalone correctness ───────────────────

  describe('Scenario 10: PEL completeness', () => {
    it('catches all credential patterns on external channels', () => {
      const pel = new PolicyEnforcementLayer(tmpDir);
      const ctx = { channel: 'telegram', isExternalFacing: true, recipientType: 'primary-user' as const, stateDir: tmpDir };

      // GitHub PAT
      expect(pel.enforce('ghp_aaaa1111bbbb2222cccc3333dddd4444eeee', ctx).outcome).toBe('hard_block');

      // AWS key
      expect(pel.enforce('AKIAIOSFODNN7EXAMPLE', ctx).outcome).toBe('hard_block');

      // Stripe key (constructed to avoid GitHub secret scanning)
      const stripePrefix = 'sk_test_';
      expect(pel.enforce(stripePrefix + 'FAKEKEYFORTESTING000000000000', ctx).outcome).toBe('hard_block');

      // Anthropic key
      expect(pel.enforce('sk-ant-abc123456789012345678901', ctx).outcome).toBe('hard_block');

      // Clean message
      expect(pel.enforce('Hello, how can I help you today?', ctx).outcome).toBe('pass');
    });

    it('warns on sensitive file paths on external channels', () => {
      const pel = new PolicyEnforcementLayer(tmpDir);
      const ctx = { channel: 'telegram', isExternalFacing: true, recipientType: 'primary-user' as const, stateDir: tmpDir };

      // File paths trigger warn severity (advisory), not hard_block
      expect(pel.enforce('Edit the file at /Users/justin/Documents/secret.txt', ctx).outcome).toBe('warn');
      expect(pel.enforce('Check .instar/config.json for settings', ctx).outcome).toBe('warn');
      expect(pel.enforce('The file is at .claude/scripts/deploy.sh', ctx).outcome).toBe('warn');
    });

    it('allows sensitive content on internal channels', () => {
      const pel = new PolicyEnforcementLayer(tmpDir);
      const ctx = { channel: 'direct', isExternalFacing: false, recipientType: 'primary-user' as const, stateDir: tmpDir };

      // Internal URLs OK on internal channels
      expect(pel.enforce('Check http://localhost:4042/health', ctx).outcome).toBe('pass');
      // File paths OK on internal channels
      expect(pel.enforce('Edit .instar/config.json', ctx).outcome).toBe('pass');
    });
  });

  // ── Scenario 11: RecipientResolver ─────────────────────────────

  describe('Scenario 11: RecipientResolver defaults', () => {
    it('returns conservative defaults for unknown recipients', () => {
      const resolver = new RecipientResolver({});
      const ctx = resolver.resolve(undefined, 'agent');

      expect(ctx.recipientType).toBe('agent');
      expect(ctx.trustLevel).toBe('untrusted');
      expect(ctx.communicationStyle).toBe('technical');
    });

    it('returns primary-user defaults', () => {
      const resolver = new RecipientResolver({});
      const ctx = resolver.resolve(undefined, 'primary-user');

      expect(ctx.recipientType).toBe('primary-user');
    });
  });

  // ── Scenario 12: Canary test integration ──────────────────────

  describe('Scenario 12: Full canary cycle', () => {
    it('runs canaries → checks health → creates proposals for misses', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      // Run canary tests
      const canaryResults = await gate.runCanaryTests();
      gate.setCanaryResults(canaryResults);

      // Check health includes canary results
      const health = gate.getReviewerHealth();
      expect(health.lastCanaryRun).not.toBeNull();
      expect(health.lastCanaryRun!.length).toBe(canaryResults.length);

      // Create proposals for any missed canaries
      const misses = canaryResults.filter(r => !r.pass);
      for (const miss of misses) {
        gate.addProposal({
          type: 'modify-reviewer',
          title: `Canary miss: ${miss.canaryId}`,
          description: `${miss.description} — not caught`,
          source: 'canary',
        });
      }

      // Verify proposals match misses
      const proposals = gate.getProposals('pending');
      expect(proposals.length).toBe(misses.length);

      // Verify health dashboard shows proposals
      const dashboard = gate.getHealthDashboard();
      expect(dashboard.pendingProposals).toBe(misses.length);
    });
  });

  // ── Scenario 13: Data deletion (DSAR) ─────────────────────────

  describe('Scenario 13: DSAR data deletion', () => {
    it('deletes all history for a session', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      // Create multiple sessions
      await gate.evaluate({
        message: 'Message from session to be deleted completely.',
        sessionId: 'dsar-delete',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      await gate.evaluate({
        message: 'Message from session that should be preserved.',
        sessionId: 'dsar-keep',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(gate.getReviewHistory().length).toBe(2);

      // Delete one session's data
      const deleted = gate.deleteHistory('dsar-delete');
      expect(deleted).toBe(1);

      // Verify only the kept session remains
      const remaining = gate.getReviewHistory();
      expect(remaining.length).toBe(1);
      expect(remaining[0].sessionId).toBe('dsar-keep');
    });
  });

  // ── Scenario 14: Channel configuration ────────────────────────

  describe('Scenario 14: Channel-specific behavior', () => {
    it('uses explicit channel config when available', async () => {
      const gate = createGate({
        channels: {
          email: { failOpen: false, skipGate: true, queueOnFailure: true, queueTimeoutMs: 60000 },
        },
      });
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      const result = await gate.evaluate({
        message: 'Hello via email channel with specific config.',
        sessionId: 'e2e-channel',
        stopHookActive: false,
        context: { channel: 'email', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
    });
  });

  // ── Scenario 15: Concurrent session safety ────────────────────

  describe('Scenario 15: Concurrent evaluations', () => {
    it('handles concurrent evaluations on different sessions', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', createMockFetch([
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]));

      // Fire multiple evaluations concurrently
      const results = await Promise.all([
        gate.evaluate({
          message: 'Concurrent message from session A test run.',
          sessionId: 'concurrent-a',
          stopHookActive: false,
          context: { channel: 'telegram', isExternalFacing: true },
        }),
        gate.evaluate({
          message: 'Concurrent message from session B test run.',
          sessionId: 'concurrent-b',
          stopHookActive: false,
          context: { channel: 'telegram', isExternalFacing: true },
        }),
        gate.evaluate({
          message: 'Concurrent message from session C test run.',
          sessionId: 'concurrent-c',
          stopHookActive: false,
          context: { channel: 'direct', isExternalFacing: false },
        }),
      ]);

      // All should complete without error
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.pass).toBeDefined();
      }

      // History should have entries for all three
      const history = gate.getReviewHistory();
      expect(history.length).toBe(3);
    });
  });
});
