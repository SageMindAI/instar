/**
 * Unit tests for MessagingToneGate B12/B13/B14 — the health-alert rules.
 *
 * These rules apply ONLY when context.messageKind === 'health-alert'. They
 * combine the new jargon and selfHeal signals with the existing
 * signal/authority architecture (see docs/signal-vs-authority.md).
 *
 * Strategy: assert that the prompt the gate sends to its provider contains
 * the right pieces, and that the gate's drift-detection accepts the new
 * rule IDs (so an LLM citing B12/B13/B14 is not treated as invalidRule).
 */

import { describe, it, expect, vi } from 'vitest';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

function captureProvider(response: object) {
  let lastPrompt = '';
  const provider: IntelligenceProvider = {
    evaluate: vi.fn(async (prompt: string, _options?: IntelligenceOptions) => {
      lastPrompt = prompt;
      return JSON.stringify(response);
    }),
  };
  return { provider, getPrompt: () => lastPrompt };
}

describe('MessagingToneGate — health-alert rules', () => {
  it('renders messageKind in the prompt', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Something on my end stopped working. Want me to dig in?', {
      channel: 'telegram',
      messageKind: 'health-alert',
    });
    expect(getPrompt()).toContain('=== MESSAGE KIND ===\nhealth-alert');
  });

  it('renders the jargon signal in the prompt when provided', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('something', {
      channel: 'telegram',
      messageKind: 'health-alert',
      signals: { jargon: { detected: true, terms: ['job', 'logs'], score: 2 } },
    });
    expect(getPrompt()).toContain('jargon detector: detected=true');
    expect(getPrompt()).toContain('terms=[job, logs]');
  });

  it('renders the selfHeal signal in the prompt when provided', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Something is wrong. Want me to dig in?', {
      channel: 'telegram',
      messageKind: 'health-alert',
      signals: { selfHeal: { attempted: true, succeeded: true, attempts: 1 } },
    });
    expect(getPrompt()).toContain('self-heal: attempted=true succeeded=true attempts=1');
  });

  it('accepts B12_HEALTH_ALERT_INTERNALS as a valid rule (no drift flag)', async () => {
    const provider: IntelligenceProvider = {
      evaluate: vi.fn(async () => JSON.stringify({
        pass: false,
        rule: 'B12_HEALTH_ALERT_INTERNALS',
        issue: 'Message names "reflection-trigger job" — internal mechanics the user cannot act on.',
        suggestion: 'Describe the impact in plain English (e.g., "my notes aren\'t sticking").',
      })),
    };
    const gate = new MessagingToneGate(provider);
    const result = await gate.review('The reflection-trigger job has been failing.', {
      channel: 'telegram',
      messageKind: 'health-alert',
      signals: { jargon: { detected: true, terms: ['job', 'trigger'], score: 2 } },
    });
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B12_HEALTH_ALERT_INTERNALS');
    expect(result.invalidRule).toBeUndefined();
    expect(result.failedOpen).toBeUndefined();
  });

  it('accepts B13_HEALTH_ALERT_SUPPRESSED_BY_HEAL as a valid rule', async () => {
    const provider: IntelligenceProvider = {
      evaluate: vi.fn(async () => JSON.stringify({
        pass: false,
        rule: 'B13_HEALTH_ALERT_SUPPRESSED_BY_HEAL',
        issue: 'Self-heal succeeded; user message suppressed.',
        suggestion: 'Drop the alert.',
      })),
    };
    const gate = new MessagingToneGate(provider);
    const result = await gate.review('My learning was stuck but I fixed it. Want me to confirm?', {
      channel: 'telegram',
      messageKind: 'health-alert',
      signals: { selfHeal: { attempted: true, succeeded: true, attempts: 1 } },
    });
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B13_HEALTH_ALERT_SUPPRESSED_BY_HEAL');
    expect(result.invalidRule).toBeUndefined();
  });

  it('accepts B14_HEALTH_ALERT_NO_CTA as a valid rule', async () => {
    const provider: IntelligenceProvider = {
      evaluate: vi.fn(async () => JSON.stringify({
        pass: false,
        rule: 'B14_HEALTH_ALERT_NO_CTA',
        issue: 'No yes/no question at the end.',
        suggestion: 'End with "Want me to dig in?"',
      })),
    };
    const gate = new MessagingToneGate(provider);
    const result = await gate.review('My learning isn\'t sticking. Check the situation.', {
      channel: 'telegram',
      messageKind: 'health-alert',
    });
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B14_HEALTH_ALERT_NO_CTA');
    expect(result.invalidRule).toBeUndefined();
  });

  it('still flags genuinely invented rule IDs as drift', async () => {
    const provider: IntelligenceProvider = {
      evaluate: vi.fn(async () => JSON.stringify({
        pass: false,
        rule: 'B99_INVENTED_RULE',
        issue: 'made up',
        suggestion: 'made up',
      })),
    };
    const gate = new MessagingToneGate(provider);
    const result = await gate.review('any message', {
      channel: 'telegram',
      messageKind: 'health-alert',
    });
    expect(result.pass).toBe(true);
    expect(result.invalidRule).toBe(true);
    expect(result.failedOpen).toBe(true);
  });

  it('defaults messageKind to "reply" when omitted', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Got it, looking into this now.', { channel: 'telegram' });
    expect(getPrompt()).toContain('=== MESSAGE KIND ===\nreply');
  });
});
