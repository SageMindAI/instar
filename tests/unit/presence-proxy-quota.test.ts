/**
 * PresenceProxy quota exhaustion detection — validates that when a session
 * hits Claude's API quota limit, the standby system reports the quota state
 * clearly instead of giving generic "agent is working" status updates.
 *
 * Root cause: When Claude's quota is exhausted, the terminal shows
 * "You've hit your limit - resets 7pm (America/Los_Angeles)" but the
 * PresenceProxy's LLM-based status update would produce a generic
 * "agent is still working" message, misleading the user.
 */

import { describe, it, expect } from 'vitest';
import { detectQuotaExhaustion, sanitizeTmuxOutput } from '../../src/monitoring/PresenceProxy.js';

describe('Quota exhaustion detection', () => {
  it('detects "hit your limit" message', () => {
    const snapshot = `Some output here
You've hit your limit - resets 7pm (America/Los_Angeles)
/extra-usage to finish what you're working on.`;
    const result = detectQuotaExhaustion(snapshot);
    expect(result).not.toBeNull();
    expect(result).toContain('usage limit');
    expect(result).toContain('7pm (America/Los_Angeles)');
  });

  it('extracts reset time from message', () => {
    const snapshot = `You've hit your limit - resets 7pm (America/Los_Angeles)`;
    const result = detectQuotaExhaustion(snapshot);
    expect(result).toContain('7pm (America/Los_Angeles)');
    expect(result).toContain('resets');
  });

  it('detects /extra-usage pattern', () => {
    const snapshot = `/extra-usage to finish what you're working on.`;
    const result = detectQuotaExhaustion(snapshot);
    expect(result).not.toBeNull();
    expect(result).toContain('usage limit');
  });

  it('detects various quota exhaustion messages', () => {
    expect(detectQuotaExhaustion('usage limit has been reached')).not.toBeNull();
    expect(detectQuotaExhaustion('quota exceeded for this period')).not.toBeNull();
    expect(detectQuotaExhaustion('rate limit exceeded')).not.toBeNull();
  });

  it('returns null for normal terminal output', () => {
    const snapshot = `echo is actively working on building the feature
npm test
All tests passing`;
    expect(detectQuotaExhaustion(snapshot)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(detectQuotaExhaustion('')).toBeNull();
  });

  it('message includes "no work is being done"', () => {
    const snapshot = `You've hit your limit - resets 7pm (America/Los_Angeles)`;
    const result = detectQuotaExhaustion(snapshot);
    expect(result).toContain('no work is being done');
  });

  it('handles resets with different time formats', () => {
    const snapshot1 = `You've hit your limit - resets 10:30pm (America/New_York)`;
    const result1 = detectQuotaExhaustion(snapshot1);
    expect(result1).toContain('10:30pm (America/New_York)');

    const snapshot2 = `You've hit your limit - resets 3am (Europe/London)`;
    const result2 = detectQuotaExhaustion(snapshot2);
    expect(result2).toContain('3am (Europe/London)');
  });
});

describe('PresenceProxy source — quota integration', () => {
  it('detectQuotaExhaustion is exported', () => {
    expect(typeof detectQuotaExhaustion).toBe('function');
  });

  it('checks for quota in all three tiers', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/monitoring/PresenceProxy.ts'),
      'utf-8'
    );

    // Should call detectQuotaExhaustion in tier 1, 2, and 3
    const matches = source.match(/detectQuotaExhaustion\(snapshot\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('short-circuits LLM call when quota detected', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/monitoring/PresenceProxy.ts'),
      'utf-8'
    );

    // The quota check should appear BEFORE the LLM call in fireTier1
    const tier1Start = source.indexOf('private async fireTier1');
    const tier1End = source.indexOf('private async fireTier2');
    const tier1Section = source.slice(tier1Start, tier1End);
    const quotaIdx = tier1Section.indexOf('detectQuotaExhaustion');
    const llmIdx = tier1Section.indexOf('callLlm');
    expect(quotaIdx).toBeGreaterThan(0);
    expect(quotaIdx).toBeLessThan(llmIdx);
  });
});
