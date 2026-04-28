/**
 * Unit tests for JargonDetector — the brittle, signal-only detector that
 * surfaces internal-jargon hits in candidate outbound messages.
 *
 * Detector is intentionally simple. The MessagingToneGate is the authority
 * that decides whether the signal warrants blocking; this file only tests
 * detection.
 */

import { describe, it, expect } from 'vitest';
import { detectJargon } from '../../src/core/JargonDetector.js';

describe('JargonDetector', () => {
  it('reports detected=false on empty input', () => {
    const result = detectJargon('');
    expect(result.detected).toBe(false);
    expect(result.terms).toEqual([]);
    expect(result.score).toBe(0);
  });

  it('reports detected=false on plain English', () => {
    const result = detectJargon('My learning isn\'t sticking right now. I tried twice and it\'s still stuck. Want me to dig in?');
    expect(result.detected).toBe(false);
    expect(result.terms).toEqual([]);
  });

  it('catches the literal Scout-Agent screenshot terms', () => {
    const screenshot = 'Critical alert: Your agent\'s learning system is broken. The reflection-trigger job has been failing silently for 18+ hours — it\'s completing but never saving learnings to memory. This was flagged 4 hours ago and is still unfixed. Your agent cannot learn or retain knowledge. Check the reflection-trigger job logs to see why it\'s exiting without saving updates. This is load-bearing infrastructure.';
    const result = detectJargon(screenshot);
    expect(result.detected).toBe(true);
    expect(result.terms).toContain('job');
    expect(result.terms).toContain('logs');
    expect(result.terms).toContain('load-bearing');
    expect(result.terms).toContain('infrastructure');
    expect(result.terms).toContain('trigger');
    expect(result.score).toBeGreaterThanOrEqual(5);
  });

  it.each([
    ['the cron job exited', ['cron', 'job']],
    ['stderr says module not found', ['stderr', 'module']],
    ['PID 1234 is the daemon', ['pid', 'daemon']],
    ['exit code 1 from the binary', ['binary', 'exit code']],
    ['load bearing infrastructure offline', ['load bearing', 'infrastructure']],
  ])('detects jargon in %s', (text, expectedTerms) => {
    const result = detectJargon(text);
    expect(result.detected).toBe(true);
    for (const term of expectedTerms) {
      expect(result.terms).toContain(term);
    }
  });

  it('does not false-positive on word-internal substrings', () => {
    // "objective" contains "ob" but not "job" at a word boundary
    const result = detectJargon('My objective today is to be helpful.');
    expect(result.terms).not.toContain('job');
  });

  it('is case-insensitive', () => {
    const result = detectJargon('The CRON JOB has stopped.');
    expect(result.terms).toContain('cron');
    expect(result.terms).toContain('job');
  });
});
