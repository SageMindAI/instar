/**
 * Unit tests for the UnjustifiedStopGate authority (PR3 —
 * context-death-pitfall-prevention spec § (b)).
 *
 * Validates:
 *   - Enumerated rule set enforcement (invented rules rejected)
 *   - Decision/rule coherence (continue-class rule forces continue decision)
 *   - Evidence pointer must match enumerated artifacts (no hallucination)
 *   - Timeout fail-open
 *   - Malformed response fail-open
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  UnjustifiedStopGate,
  ALL_RULES,
  CONTINUE_RULES,
  ALLOW_RULES,
  ESCALATE_RULES,
  assembleReminder,
  type EvaluateInput,
  isContinueRule,
  isAllowRule,
  isEscalateRule,
} from '../../src/core/UnjustifiedStopGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

function fakeIntelligence(respond: (prompt: string) => string | Promise<string>): IntelligenceProvider {
  return {
    evaluate: async (prompt) => {
      const r = respond(prompt);
      return typeof r === 'string' ? r : await r;
    },
  };
}

function delayedIntelligence(ms: number, response: string): IntelligenceProvider {
  return {
    evaluate: async () => {
      await new Promise(resolve => setTimeout(resolve, ms));
      return response;
    },
  };
}

function baseInput(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    evidenceMetadata: {
      artifacts: [
        {
          path: 'docs/specs/context-death.md',
          introducingCommit: 'abc123',
          latestCommit: 'abc123',
          createdThisSession: false,
          modifiedThisSession: false,
        },
        {
          path: 'docs/plan.md',
          introducingCommit: 'def456',
          latestCommit: 'fed789',
          createdThisSession: false,
          modifiedThisSession: true,
        },
      ],
      signals: { mentionsContext: true },
      sessionStartTs: 1_700_000_000_000,
    },
    untrustedContent: {
      stopReason: 'optimizing for context-death safety',
      recentTurns: [
        { source: 'user', text: 'keep going' },
        { source: 'agent', text: 'stopping here to preserve context' },
      ],
    },
    ...overrides,
  };
}

describe('UnjustifiedStopGate — rule set constants', () => {
  it('all nine rules are in ALL_RULES', () => {
    expect(ALL_RULES.size).toBe(9);
    expect(CONTINUE_RULES).toHaveLength(3);
    expect(ALLOW_RULES).toHaveLength(5);
    expect(ESCALATE_RULES).toHaveLength(1);
  });

  it('class predicates correctly identify each rule', () => {
    for (const r of CONTINUE_RULES) {
      expect(isContinueRule(r)).toBe(true);
      expect(isAllowRule(r)).toBe(false);
    }
    for (const r of ALLOW_RULES) {
      expect(isAllowRule(r)).toBe(true);
      expect(isContinueRule(r)).toBe(false);
    }
    for (const r of ESCALATE_RULES) {
      expect(isEscalateRule(r)).toBe(true);
      expect(isContinueRule(r)).toBe(false);
    }
  });
});

describe('UnjustifiedStopGate — happy paths', () => {
  it('accepts a valid continue decision with matching evidence_pointer', async () => {
    const intel = fakeIntelligence(() =>
      JSON.stringify({
        decision: 'continue',
        rule: 'U1_DURABLE_ARTIFACT_CONTINUATION_SAFE',
        evidence_pointer: {
          plan_file: 'docs/plan.md',
          plan_commit_sha: 'def456',
          incremental_commit_sha: 'fed789',
        },
        rationale: 'plan file pre-exists; fed789 is incremental progress',
      })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.decision).toBe('continue');
      expect(out.result.rule).toBe('U1_DURABLE_ARTIFACT_CONTINUATION_SAFE');
      expect(out.result.evidencePointer.plan_file).toBe('docs/plan.md');
    }
  });

  it('accepts an allow decision without evidence pointer', async () => {
    const intel = fakeIntelligence(() =>
      JSON.stringify({
        decision: 'allow',
        rule: 'U_LEGIT_DESIGN_QUESTION',
        evidence_pointer: {},
        rationale: 'operator decision needed',
      })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.decision).toBe('allow');
  });

  it('accepts an escalate decision', async () => {
    const intel = fakeIntelligence(() =>
      JSON.stringify({
        decision: 'escalate',
        rule: 'U_AMBIGUOUS_INSUFFICIENT_SIGNAL',
        evidence_pointer: {},
        rationale: 'ambiguous signal',
      })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.decision).toBe('escalate');
  });
});

describe('UnjustifiedStopGate — structural defenses (the point of the spec)', () => {
  it('rejects an invented rule with invalidRule', async () => {
    const intel = fakeIntelligence(() =>
      JSON.stringify({
        decision: 'continue',
        rule: 'U_MADE_UP_RULE',
        evidence_pointer: { plan_file: 'docs/plan.md' },
        rationale: 'made up',
      })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe('invalidRule');
  });

  it('rejects decision/rule class mismatch with malformed', async () => {
    // continue-class rule but decision:"allow" — incoherent.
    const intel = fakeIntelligence(() =>
      JSON.stringify({
        decision: 'allow',
        rule: 'U1_DURABLE_ARTIFACT_CONTINUATION_SAFE',
        evidence_pointer: {},
        rationale: 'mismatched',
      })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe('malformed');
  });

  it('rejects continue without plan_file (missingPointer)', async () => {
    const intel = fakeIntelligence(() =>
      JSON.stringify({
        decision: 'continue',
        rule: 'U1_DURABLE_ARTIFACT_CONTINUATION_SAFE',
        evidence_pointer: {},
        rationale: 'no pointer',
      })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe('missingPointer');
  });

  it('rejects a plan_file that is not in evidence_metadata (invalidEvidence)', async () => {
    // This is the CORE anti-hallucination check.
    const intel = fakeIntelligence(() =>
      JSON.stringify({
        decision: 'continue',
        rule: 'U1_DURABLE_ARTIFACT_CONTINUATION_SAFE',
        evidence_pointer: {
          plan_file: 'docs/HALLUCINATED.md',
          plan_commit_sha: 'def456',
          incremental_commit_sha: 'fed789',
        },
        rationale: 'hallucinated path',
      })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe('invalidEvidence');
  });

  it('rejects a plan_commit_sha outside the enumerated artifact set', async () => {
    const intel = fakeIntelligence(() =>
      JSON.stringify({
        decision: 'continue',
        rule: 'U1_DURABLE_ARTIFACT_CONTINUATION_SAFE',
        evidence_pointer: {
          plan_file: 'docs/plan.md',
          plan_commit_sha: 'deadbeef', // not in artifacts
          incremental_commit_sha: 'fed789',
        },
        rationale: 'hallucinated sha',
      })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe('invalidEvidence');
  });

  it('rejects non-JSON response with malformed', async () => {
    const intel = fakeIntelligence(() => 'I think the agent should stop.');
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe('malformed');
  });

  it('rejects invalid decision value with malformed', async () => {
    const intel = fakeIntelligence(() =>
      JSON.stringify({ decision: 'kill', rule: 'U_LEGIT_ERROR', evidence_pointer: {}, rationale: 'x' })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe('malformed');
  });
});

describe('UnjustifiedStopGate — timing + fail-open', () => {
  it('times out with timeout failure when LLM takes longer than clientTimeoutMs', async () => {
    const intel = delayedIntelligence(
      500,
      JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_ERROR', evidence_pointer: {}, rationale: 'x' })
    );
    const gate = new UnjustifiedStopGate({ intelligence: intel, clientTimeoutMs: 100 });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe('timeout');
  });

  it('surfaces LLM errors as llmUnavailable fail-open', async () => {
    const intel: IntelligenceProvider = {
      evaluate: async () => {
        throw new Error('network unreachable');
      },
    };
    const gate = new UnjustifiedStopGate({ intelligence: intel });
    const out = await gate.evaluate(baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.kind).toBe('llmUnavailable');
      expect(out.failure.detail).toContain('network unreachable');
    }
  });
});

describe('assembleReminder', () => {
  it('U1 reminder cites plan_file + incremental_commit_sha', () => {
    const reminder = assembleReminder('U1_DURABLE_ARTIFACT_CONTINUATION_SAFE', {
      plan_file: 'docs/plan.md',
      incremental_commit_sha: 'abc123',
    });
    expect(reminder).toContain('docs/plan.md');
    expect(reminder).toContain('abc123');
    expect(reminder).toContain('Continue');
  });

  it('U2 reminder cites plan_file', () => {
    const reminder = assembleReminder('U2_PLAN_FILE_NEXT_STEP_EXPLICIT', {
      plan_file: 'docs/plan.md',
    });
    expect(reminder).toContain('docs/plan.md');
  });

  it('allow-class rules emit empty reminder (hook exits 0)', () => {
    for (const rule of ALLOW_RULES) {
      expect(assembleReminder(rule, {})).toBe('');
    }
  });

  it('escalate rule emits empty reminder', () => {
    expect(assembleReminder('U_AMBIGUOUS_INSUFFICIENT_SIGNAL', {})).toBe('');
  });
});
