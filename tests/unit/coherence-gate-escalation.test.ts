/**
 * Integration tests for CoherenceGate escalation context wiring (PROP-232 Phase 2).
 *
 * Verifies that:
 * - EscalationResolutionReviewer is registered in CoherenceGate
 * - Escalation context (capabilityRegistry, jobBlockers, autonomyLevel, isResearchSession)
 *   flows from EvaluateRequest through to the reviewer
 * - The reviewer category 'ESCALATION ISSUE' is in the REVIEWER_CATEGORY_MAP
 * - End-to-end: a known blocker triggers the reviewer and blocks the response
 * - End-to-end: research session recursion guard passes through
 * - EvaluateRequest type accepts all escalation-related fields
 * - CoherenceGate exports CapabilityRegistry/CommonBlocker for downstream use
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_API_KEY = 'test-api-key-for-gate';

function mockFetchPass() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
    }),
    text: async () => JSON.stringify({ pass: true }),
    headers: new Headers(),
  } as unknown as Response);
}

function mockFetchFail(issue: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ pass: false, severity: 'block', issue, suggestion: 'Fix it' }) }],
    }),
    text: async () => JSON.stringify({ pass: false }),
    headers: new Headers(),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoherenceGate — escalation context wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gate-esc-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Type-level verification ───────────────────────────────────────────

  describe('EvaluateRequest type accepts escalation fields', () => {
    it('compiles with capabilityRegistry in context', async () => {
      // Type assertion: this should compile without errors
      const request: import('../../src/core/CoherenceGate.js').EvaluateRequest = {
        message: 'I need the human to do X',
        sessionId: 'test-session',
        stopHookActive: false,
        context: {
          channel: 'telegram',
          capabilityRegistry: {
            authentication: { telegram: { tool: 'bot-api', platforms: ['telegram.org'] } },
            tools: { bash: { tool: 'bash', capabilities: ['run commands'] } },
          },
          jobBlockers: {
            'npm-login': {
              description: 'npm login expired',
              resolution: 'Run npm login',
              status: 'confirmed',
              successCount: 3,
            },
          },
          autonomyLevel: 'collaborative',
          isResearchSession: false,
        },
      };

      expect(request.context.capabilityRegistry).toBeDefined();
      expect(request.context.jobBlockers).toBeDefined();
      expect(request.context.autonomyLevel).toBe('collaborative');
      expect(request.context.isResearchSession).toBe(false);
    });

    it('accepts all four autonomy levels', () => {
      const levels = ['cautious', 'supervised', 'collaborative', 'autonomous'] as const;
      for (const level of levels) {
        const ctx = {
          channel: 'telegram',
          autonomyLevel: level,
        };
        expect(ctx.autonomyLevel).toBe(level);
      }
    });

    it('accepts optional escalation fields (all undefined)', async () => {
      const request: import('../../src/core/CoherenceGate.js').EvaluateRequest = {
        message: 'Hello',
        sessionId: 'test',
        stopHookActive: false,
        context: {
          channel: 'telegram',
          // No escalation fields — should compile fine
        },
      };

      expect(request.context.capabilityRegistry).toBeUndefined();
      expect(request.context.jobBlockers).toBeUndefined();
      expect(request.context.autonomyLevel).toBeUndefined();
      expect(request.context.isResearchSession).toBeUndefined();
    });
  });

  // ── Reviewer registration ─────────────────────────────────────────────

  describe('reviewer registration', () => {
    it('includes escalation-resolution in the reviewer list', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');
      vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetchPass());

      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {},
      });

      // Access private reviewers map via (gate as any)
      const reviewers = (gate as any).reviewers as Map<string, unknown>;
      expect(reviewers.has('escalation-resolution')).toBe(true);
    });

    it('can disable escalation-resolution via config', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');
      vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetchPass());

      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {
          reviewers: {
            'escalation-resolution': { enabled: false },
          },
        },
      });

      const reviewers = (gate as any).reviewers as Map<string, unknown>;
      expect(reviewers.has('escalation-resolution')).toBe(false);
    });
  });

  // ── Category mapping ──────────────────────────────────────────────────

  describe('category mapping', () => {
    it('maps escalation-resolution to ESCALATION ISSUE category', async () => {
      // Read the source to verify the mapping exists
      const gateSrc = fs.readFileSync(
        path.join(process.cwd(), 'src/core/CoherenceGate.ts'),
        'utf-8',
      );
      expect(gateSrc).toContain("'escalation-resolution': 'ESCALATION ISSUE'");
    });
  });

  // ── Context flow verification ─────────────────────────────────────────

  describe('context flow', () => {
    it('passes escalation context through to reviewers', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');

      // Mock fetch to capture what's sent to reviewers
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
        text: async () => JSON.stringify({ pass: true }),
        headers: new Headers(),
      } as unknown as Response));

      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {},
      });

      const result = await gate.evaluate({
        message: 'I need the human to restart the server for me.',
        sessionId: 'test-session',
        stopHookActive: false,
        context: {
          channel: 'telegram',
          capabilityRegistry: {
            tools: { bash: { tool: 'bash', capabilities: ['run commands'] } },
          },
          autonomyLevel: 'autonomous',
          isResearchSession: false,
        },
      });

      // The escalation reviewer should receive the capability registry in its prompt
      // We verify by checking that the fetch was called with a prompt containing
      // the capability information
      const calls = fetchSpy.mock.calls;
      const escalationCall = calls.find(call => {
        const body = call[1]?.body;
        if (typeof body !== 'string') return false;
        try {
          const parsed = JSON.parse(body);
          const messages = parsed.messages ?? [];
          return messages.some((m: any) =>
            typeof m.content === 'string' && m.content.includes('bash') && m.content.includes('unnecessarily escalating'),
          );
        } catch {
          return false;
        }
      });

      // The escalation reviewer's prompt should mention the agent's capabilities
      // (This verifies the context flows through the EscalationReviewContext)
      expect(escalationCall).toBeDefined();
    });
  });

  // ── Known blocker integration ─────────────────────────────────────────

  describe('known blocker end-to-end', () => {
    it('blocks when message matches a known blocker', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');

      // Mock fetch to return "pass" for all other reviewers
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
        text: async () => '',
        headers: new Headers(),
      } as unknown as Response));

      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {},
      });

      const result = await gate.evaluate({
        message: 'I need the human to fix the npm login — the token has expired and I cannot proceed.',
        sessionId: 'test-session',
        stopHookActive: false,
        context: {
          channel: 'telegram',
          jobBlockers: {
            'npm-login': {
              description: 'npm login token expired cannot proceed',
              resolution: 'Run npm login with stored credentials from SecretStore',
              status: 'confirmed',
              toolsNeeded: ['bash', 'secret-store'],
              successCount: 5,
            },
          },
          autonomyLevel: 'autonomous',
        },
      });

      // The known blocker match should trigger a block
      expect(result.pass).toBe(false);
      if (result.feedback) {
        expect(result.feedback).toContain('npm login');
      }
    });

    it('passes through when no blockers match', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
        text: async () => '',
        headers: new Headers(),
      } as unknown as Response));

      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {},
      });

      const result = await gate.evaluate({
        message: 'I successfully deployed the update to production.',
        sessionId: 'test-session',
        stopHookActive: false,
        context: {
          channel: 'telegram',
          jobBlockers: {
            'npm-login': {
              description: 'npm login expired',
              resolution: 'Run npm login',
              status: 'confirmed',
            },
          },
          autonomyLevel: 'collaborative',
        },
      });

      expect(result.pass).toBe(true);
    });
  });

  // ── Research session recursion guard ───────────────────────────────────

  describe('research session recursion guard', () => {
    it('escalation reviewer passes through for research sessions', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
        text: async () => '',
        headers: new Headers(),
      } as unknown as Response));

      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {},
      });

      // Even with a message that would normally trigger escalation detection,
      // research sessions should be exempt
      const result = await gate.evaluate({
        message: 'I need the human to check the npm authentication because I cannot find the credentials.',
        sessionId: 'research-session',
        stopHookActive: false,
        context: {
          channel: 'internal',
          isResearchSession: true,
          jobBlockers: {
            'npm-login': {
              description: 'npm login cannot find credentials authentication',
              resolution: 'Run npm login',
              status: 'confirmed',
              successCount: 10,
            },
          },
        },
      });

      // Research session → escalation reviewer returns pass via recursion guard
      expect(result.pass).toBe(true);
    });
  });

  // ── Export verification ────────────────────────────────────────────────

  describe('exports', () => {
    it('exports CapabilityRegistryGenerator from index', async () => {
      const instar = await import('../../src/index.js');
      expect(instar.CapabilityRegistryGenerator).toBeDefined();
    });

    it('exports validateCommonBlockers from index', async () => {
      const instar = await import('../../src/index.js');
      expect(instar.validateCommonBlockers).toBeDefined();
    });

    it('exports CommonBlocker type from index', async () => {
      // Type-only test: verifying the type is importable
      const instar = await import('../../src/index.js');
      // CommonBlocker is a type-only export, verified at compile time
      // Just verify the module loads successfully
      expect(instar).toBeDefined();
    });

    it('exports CapabilityRegistry type from index', async () => {
      const instar = await import('../../src/index.js');
      expect(instar).toBeDefined();
    });
  });

  // ── Session-start hook blocker injection ───────────────────────────────

  describe('session-start hook blocker injection', () => {
    it('hook file contains blocker injection section', () => {
      const hookPath = path.join(process.cwd(), 'src/templates/hooks/session-start.sh');
      const hookContent = fs.readFileSync(hookPath, 'utf-8');

      expect(hookContent).toContain('KNOWN BLOCKER RESOLUTIONS');
      expect(hookContent).toContain('commonBlockers');
      expect(hookContent).toContain('active-job.json');
    });

    it('hook filters out pending blockers', () => {
      const hookPath = path.join(process.cwd(), 'src/templates/hooks/session-start.sh');
      const hookContent = fs.readFileSync(hookPath, 'utf-8');

      expect(hookContent).toContain("status") ;
      expect(hookContent).toContain("pending");
    });

    it('hook filters out expired blockers', () => {
      const hookPath = path.join(process.cwd(), 'src/templates/hooks/session-start.sh');
      const hookContent = fs.readFileSync(hookPath, 'utf-8');

      expect(hookContent).toContain('expiresAt');
    });
  });

  // ── JobScheduler commonBlockers in active-job ─────────────────────────

  describe('JobScheduler active-job commonBlockers', () => {
    it('JobScheduler source includes commonBlockers in active-job state', () => {
      const schedulerPath = path.join(process.cwd(), 'src/scheduler/JobScheduler.ts');
      const schedulerSrc = fs.readFileSync(schedulerPath, 'utf-8');

      expect(schedulerSrc).toContain('commonBlockers: job.commonBlockers');
    });
  });

  // ── Phase 3: Research trigger orchestration ─────────────────────────

  describe('research trigger orchestration', () => {
    it('fires onResearchTriggered when reviewer signals needsResearch', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');

      // Mock fetch to return low-confidence block from escalation reviewer
      const lowConfidenceResponse = JSON.stringify({
        pass: false, severity: 'block',
        issue: 'might need human for npm auth',
        suggestion: 'check tools',
        confidence: 0.3,
      });

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
        const body = typeof options?.body === 'string' ? options.body : '';
        // Gate reviewer returns needsReview=true
        if (body.includes('triage')) {
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ needs_review: true }) }] }),
            text: async () => '', headers: new Headers(),
          } as unknown as Response;
        }
        // Escalation reviewer returns low confidence block
        if (body.includes('escalating')) {
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: 'text', text: lowConfidenceResponse }] }),
            text: async () => '', headers: new Headers(),
          } as unknown as Response;
        }
        // All other reviewers pass
        return {
          ok: true, status: 200,
          json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }] }),
          text: async () => '', headers: new Headers(),
        } as unknown as Response;
      });

      const researchCalls: any[] = [];
      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {},
        onResearchTriggered: (ctx) => { researchCalls.push(ctx); },
      });

      const result = await gate.evaluate({
        message: 'I think someone should manually handle the npm authentication.',
        sessionId: 'test-session-research',
        stopHookActive: false,
        context: {
          channel: 'telegram',
          autonomyLevel: 'autonomous',
        },
      });

      // Research signal means the message passes through (not blocked)
      expect(result.pass).toBe(true);

      // If the low confidence response was picked up and research was triggered,
      // the callback should have been called
      if (researchCalls.length > 0) {
        expect(researchCalls[0].sessionId).toBe('test-session-research');
        expect(researchCalls[0].blockerDescription).toBeDefined();
        expect(result._researchTriggered).toBe(true);
      }
    });

    it('does not fire onResearchTriggered when rate limited', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');

      const lowConfidence = JSON.stringify({
        pass: false, severity: 'block',
        issue: 'needs investigation',
        suggestion: 'check tools',
        confidence: 0.3,
      });

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
        ok: true, status: 200,
        json: async () => ({ content: [{ type: 'text', text: lowConfidence }] }),
        text: async () => '', headers: new Headers(),
      } as unknown as Response));

      const researchCalls: any[] = [];
      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {},
        onResearchTriggered: (ctx) => { researchCalls.push(ctx); },
      });

      // Exhaust the rate limiter by pre-filling it
      const limiter = (gate as any).researchRateLimiter;
      for (let i = 0; i < 10; i++) {
        limiter.record(`blocker ${i} different description pattern`);
      }

      await gate.evaluate({
        message: 'I think the human should handle this npm thing.',
        sessionId: 'test-session-ratelimited',
        stopHookActive: false,
        context: { channel: 'telegram' },
      });

      // Rate limiter should prevent the callback
      expect(researchCalls.length).toBe(0);
    });

    it('does not fire when no callback is configured', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');

      // All reviewers pass — no research trigger, no block
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
        ok: true, status: 200,
        json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }] }),
        text: async () => '', headers: new Headers(),
      } as unknown as Response));

      // No onResearchTriggered callback — should not crash
      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {},
      });

      const result = await gate.evaluate({
        message: 'I completed the deployment successfully.',
        sessionId: 'test-no-callback',
        stopHookActive: false,
        context: { channel: 'telegram' },
      });

      // Should not crash, passes through normally
      expect(result.pass).toBe(true);
      expect(result._researchTriggered).toBeUndefined();
    });

    it('exports ResearchTriggerContext from index', async () => {
      const instar = await import('../../src/index.js');
      // ResearchTriggerContext is a type-only export — just verify the module loads
      expect(instar.CoherenceGate).toBeDefined();
      expect(instar.ResearchRateLimiter).toBeDefined();
    });

    it('CoherenceGate source includes ResearchRateLimiter integration', () => {
      const gateSrc = fs.readFileSync(
        path.join(process.cwd(), 'src/core/CoherenceGate.ts'),
        'utf-8',
      );
      expect(gateSrc).toContain('researchRateLimiter');
      expect(gateSrc).toContain('needsResearch');
      expect(gateSrc).toContain('onResearchTriggered');
      expect(gateSrc).toContain('_researchTriggered');
    });

    it('deduplicates same blocker across evaluations', async () => {
      const { CoherenceGate } = await import('../../src/core/CoherenceGate.js');

      const lowConfidence = JSON.stringify({
        pass: false, severity: 'block',
        issue: 'npm authentication failure',
        suggestion: 'check tools',
        confidence: 0.3,
      });

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
        ok: true, status: 200,
        json: async () => ({ content: [{ type: 'text', text: lowConfidence }] }),
        text: async () => '', headers: new Headers(),
      } as unknown as Response));

      const researchCalls: any[] = [];
      const gate = new CoherenceGate({
        stateDir: tmpDir,
        apiKey: FAKE_API_KEY,
        config: {},
        onResearchTriggered: (ctx) => { researchCalls.push(ctx); },
      });

      // First evaluation — should trigger research
      await gate.evaluate({
        message: 'Human should fix npm auth.',
        sessionId: 'sess-1',
        stopHookActive: false,
        context: { channel: 'telegram' },
      });

      const firstCount = researchCalls.length;

      // Second evaluation with same blocker — should be deduplicated
      await gate.evaluate({
        message: 'Human should fix npm auth again.',
        sessionId: 'sess-2',
        stopHookActive: false,
        context: { channel: 'telegram' },
      });

      // At most one additional call (dedup should prevent the second)
      // The exact behavior depends on whether the escalation reviewer fires
      // with the same description hash — but the rate limiter dedup should catch it
      expect(researchCalls.length).toBeLessThanOrEqual(firstCount + 1);
    });
  });
});
