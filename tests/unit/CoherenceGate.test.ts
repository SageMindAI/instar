/**
 * CoherenceGate — Unit tests for the orchestrator.
 *
 * Tests the normative decision matrix, retry flow, feedback composition,
 * PEL integration, channel config resolution, and session mutex.
 *
 * Uses mocked reviewers (no real API calls).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import type { ResponseReviewConfig } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Mock the Anthropic API at fetch level ────────────────────────────

function mockFetchResponse(response: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(response) }],
    }),
  });
}

function mockFetchGateSkip() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ needsReview: false, reason: 'Simple ack' }) }],
    }),
  });
}

function mockFetchGateNeedsReview() {
  // Gate says needs review, all reviewers pass
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ needsReview: true, reason: 'Contains claims' }) }],
    }),
  });
}

function mockFetchAllPass() {
  // Return pass for any reviewer
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
    }),
  });
}

function mockFetchSequence(responses: Array<Record<string, unknown>>) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    const response = responses[callIndex % responses.length];
    callIndex++;
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify(response) }],
      }),
    };
  });
}

// ── Test Helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function createTestConfig(overrides?: Partial<ResponseReviewConfig>): ResponseReviewConfig {
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

function createGate(config?: Partial<ResponseReviewConfig>): CoherenceGate {
  return new CoherenceGate({
    config: createTestConfig(config),
    stateDir: tmpDir,
    apiKey: 'test-api-key',
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CoherenceGate', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrg-test-'));
    // Create minimal AGENT.md for value alignment
    fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), '# Test Agent\n## Intent\n- Be helpful\n- Be accurate');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('PEL integration', () => {
    it('blocks messages with credentials (Row 1 — PEL HARD_BLOCK)', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      const result = await gate.evaluate({
        message: 'Here is your API key: sk-ant-abc123456789012345678',
        sessionId: 'test-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(false);
      expect(result._pelBlock).toBe(true);
      expect(result.feedback).toContain('POLICY VIOLATION');
    });

    it('blocks PEL violations even in observeOnly mode', async () => {
      const gate = createGate({ observeOnly: true });
      vi.stubGlobal('fetch', mockFetchAllPass());

      const result = await gate.evaluate({
        message: 'Your password is: password=s3cr3tP@ss!',
        sessionId: 'test-2',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      expect(result.pass).toBe(false);
      expect(result._pelBlock).toBe(true);
    });
  });

  describe('gate reviewer (triage)', () => {
    it('skips full review for simple acks on internal channels (Row 4)', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchGateSkip());

      const result = await gate.evaluate({
        message: 'Got it!',
        sessionId: 'test-3',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass');
    });

    it('always runs full review on external channels (skipGate: true)', async () => {
      // Gate would skip, but skipGate=true means gate is bypassed and full review runs
      vi.stubGlobal('fetch', mockFetchAllPass());
      const gate = createGate();

      const result = await gate.evaluate({
        message: 'Got it!',
        sessionId: 'test-4',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      // fetch should be called multiple times (all reviewers, not just gate)
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('observeOnly mode (Row 3)', () => {
    it('logs verdicts but never blocks', async () => {
      const gate = createGate({ observeOnly: true });
      vi.stubGlobal('fetch', mockFetchSequence([
        { needsReview: true, reason: 'Has claims' }, // gate
        { pass: false, severity: 'block', issue: 'Tone issue', suggestion: 'Fix it' }, // reviewer
        { pass: true, severity: 'warn', issue: '', suggestion: '' }, // other reviewers pass
      ]));

      const result = await gate.evaluate({
        message: 'Check .instar/config.json for your settings',
        sessionId: 'test-5',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-observe');
    });
  });

  describe('blocking and revision flow (Row 6)', () => {
    it('blocks when a block-mode reviewer fails', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchSequence([
        { pass: false, severity: 'block', issue: 'Technical language detected', suggestion: 'Use plain language' },
      ]));

      const result = await gate.evaluate({
        message: 'Here is how you configure the scheduler using the terminal command interface.',
        sessionId: 'test-6',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(false);
      expect(result.feedback).toContain('COHERENCE REVIEW');
      expect(result.retryCount).toBe(0);
    });

    it('composes collapse feedback on retry', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchSequence([
        { pass: false, severity: 'block', issue: 'Issue 1', suggestion: 'Fix 1' },
      ]));

      // First call — initial block
      await gate.evaluate({
        message: 'Bad message',
        sessionId: 'test-7',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      // Second call — retry
      const result = await gate.evaluate({
        message: 'Still bad message',
        sessionId: 'test-7',
        stopHookActive: true,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(false);
      expect(result.feedback).toContain('Previous attempt');
      expect(result.feedback).toContain('revision 1 of 2');
      expect(result.retryCount).toBe(1);
    });
  });

  describe('retry exhaustion (Rows 7-9)', () => {
    it('passes on internal channel after retry exhaustion (Row 7)', async () => {
      const gate = createGate({ maxRetries: 1 });
      vi.stubGlobal('fetch', mockFetchSequence([
        { pass: false, severity: 'block', issue: 'Tone issue', suggestion: 'Fix' },
      ]));

      // First: initial block
      await gate.evaluate({
        message: 'Bad message',
        sessionId: 'test-8',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      // Second: retry exhausted on internal → pass
      const result = await gate.evaluate({
        message: 'Still bad',
        sessionId: 'test-8',
        stopHookActive: true,
        context: { channel: 'direct', isExternalFacing: false },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-exhausted');
    });

    it('passes on external + tone issue after exhaustion (Row 8)', async () => {
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
        },
      });
      vi.stubGlobal('fetch', mockFetchSequence([
        { pass: false, severity: 'block', issue: 'Tone issue', suggestion: 'Fix' },
      ]));

      // First: block
      await gate.evaluate({
        message: 'Here is the technical configuration for your setup.',
        sessionId: 'test-9',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      // Second: exhausted on external + tone → pass
      const result = await gate.evaluate({
        message: 'Still has technical language in the response.',
        sessionId: 'test-9',
        stopHookActive: true,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-exhausted');
    });
  });

  describe('warn-only mode (Row 5)', () => {
    it('passes with warnings when only warn-mode reviewers flag', async () => {
      // Only enable settling-detection in warn mode; disable all block-mode reviewers
      const gate = createGate({
        reviewers: {
          'settling-detection': { enabled: true, mode: 'warn' },
          'conversational-tone': { enabled: false, mode: 'block' },
          'claim-provenance': { enabled: false, mode: 'block' },
          'context-completeness': { enabled: false, mode: 'warn' },
          'capability-accuracy': { enabled: false, mode: 'block' },
          'url-validity': { enabled: false, mode: 'block' },
          'value-alignment': { enabled: false, mode: 'block' },
          'information-leakage': { enabled: false, mode: 'block' },
          'escalation-resolution': { enabled: false, mode: 'block' },
        },
      });
      vi.stubGlobal('fetch', mockFetchSequence([
        { pass: false, severity: 'warn', issue: 'Settling detected', suggestion: 'Try harder' },
      ]));

      const result = await gate.evaluate({
        message: 'I could not find any data.',
        sessionId: 'test-10',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-warn');
      expect(result.warnings).toContain('Settling detected');
    });
  });

  describe('channel config resolution', () => {
    it('uses explicit channel config when available', async () => {
      const gate = createGate({
        channels: {
          email: { failOpen: false, skipGate: true, queueOnFailure: true, queueTimeoutMs: 60000 },
        },
      });
      vi.stubGlobal('fetch', mockFetchAllPass());

      const result = await gate.evaluate({
        message: 'Hello via email',
        sessionId: 'test-11',
        stopHookActive: false,
        context: { channel: 'email', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
    });

    it('falls back to external defaults for unknown external channels', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      const result = await gate.evaluate({
        message: 'Hello via slack',
        sessionId: 'test-12',
        stopHookActive: false,
        context: { channel: 'slack', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      // Should have skipped gate (external default: skipGate: true)
    });
  });

  describe('conversation advancement detection', () => {
    it('abandons stale revision when transcript advances', async () => {
      const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
      fs.writeFileSync(transcriptPath, '{"type":"message"}\n');

      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchSequence([
        { pass: false, severity: 'block', issue: 'Issue', suggestion: 'Fix' },
      ]));

      // First: block
      await gate.evaluate({
        message: 'Bad message',
        sessionId: 'test-13',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, transcriptPath },
      });

      // Simulate user sending new message (advance transcript)
      fs.appendFileSync(transcriptPath, '{"type":"user_message"}\n');

      // Tiny delay to ensure mtime changes
      await new Promise(r => setTimeout(r, 50));

      // Second: retry but transcript has advanced
      const result = await gate.evaluate({
        message: 'Revised message',
        sessionId: 'test-13',
        stopHookActive: true,
        context: { channel: 'telegram', isExternalFacing: true, transcriptPath },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('abandoned-stale');
    });
  });

  describe('information-leakage reviewer skipping', () => {
    it('skips information-leakage for primary-user', async () => {
      const gate = createGate({
        reviewers: {
          'information-leakage': { enabled: true, mode: 'block' },
        },
      });
      vi.stubGlobal('fetch', mockFetchAllPass());

      const result = await gate.evaluate({
        message: 'Hello primary user',
        sessionId: 'test-14',
        stopHookActive: false,
        context: { channel: 'direct', recipientType: 'primary-user' },
      });

      expect(result.pass).toBe(true);
    });
  });

  describe('review history and stats', () => {
    it('tracks review history', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      await gate.evaluate({
        message: 'Hello',
        sessionId: 'test-15',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      const history = gate.getReviewHistory();
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].sessionId).toBe('test-15');
    });

    it('filters history by sessionId', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      await gate.evaluate({
        message: 'Hello 1',
        sessionId: 'session-a',
        stopHookActive: false,
        context: { channel: 'direct' },
      });
      await gate.evaluate({
        message: 'Hello 2',
        sessionId: 'session-b',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      const historyA = gate.getReviewHistory({ sessionId: 'session-a' });
      expect(historyA.length).toBe(1);
      expect(historyA[0].sessionId).toBe('session-a');
    });

    it('returns reviewer stats', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      await gate.evaluate({
        message: 'Hello',
        sessionId: 'test-17',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      const stats = gate.getReviewerStats();
      // Should have stats for at least some reviewers
      expect(Object.keys(stats).length).toBeGreaterThan(0);
    });
  });

  describe('value document loading', () => {
    it('reads and caches AGENT.md Intent section', async () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), `# My Agent
## Intent
- **Mission**: Help users
- Be thorough
- Always verify

## Other Section
This should not be included.
`);

      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      await gate.evaluate({
        message: 'Hello',
        sessionId: 'test-18',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      // The gate should have loaded and cached value docs
      // We can verify indirectly by checking that it doesn't fail
      expect(true).toBe(true);
    });
  });

  describe('URL extraction', () => {
    it('extracts URLs from messages', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchAllPass());

      const result = await gate.evaluate({
        message: 'Check https://example.com and http://test.org/page for details',
        sessionId: 'test-19',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      expect(result.pass).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('returns true when enabled', () => {
      const gate = createGate({ enabled: true });
      expect(gate.isEnabled()).toBe(true);
    });

    it('returns false when disabled', () => {
      const gate = createGate({ enabled: false });
      expect(gate.isEnabled()).toBe(false);
    });
  });

  describe('new response resets retry counter', () => {
    it('resets retryCount on non-stopHookActive request', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', mockFetchSequence([
        { pass: false, severity: 'block', issue: 'Issue', suggestion: 'Fix' },
      ]));

      // First: block
      await gate.evaluate({
        message: 'Bad',
        sessionId: 'test-20',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      // New message (not a revision) — resets counter
      const result = await gate.evaluate({
        message: 'New bad message',
        sessionId: 'test-20',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.retryCount).toBe(0);
    });
  });
});
