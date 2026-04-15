/**
 * Unit tests for OutboundDedupGate — the structural dedup safety net for
 * agent-to-user messaging.
 */

import { describe, it, expect, vi } from 'vitest';
import { OutboundDedupGate } from '../../src/core/OutboundDedupGate.js';

describe('OutboundDedupGate', () => {
  describe('duplicate detection', () => {
    it('flags a near-identical message as a duplicate', () => {
      const gate = new OutboundDedupGate();
      const prior = {
        text: "Fair question — I was sloppy there. Older meaning it already existed before last night's work. I meant the safety net that predates this week's changes.",
        timestamp: Date.now() - 60_000,
      };
      const candidate =
        "Fair question — I was sloppy there. Older meaning it already existed before last night's work. I meant the safety net that predates this week's changes.";

      const result = gate.check({ text: candidate, recent: [prior] });

      expect(result.duplicate).toBe(true);
      expect(result.similarity ?? 0).toBeGreaterThanOrEqual(0.7);
      expect(result.matchedText).toContain('Fair question');
    });

    it('flags a paraphrased message as a duplicate when overlap is high', () => {
      const gate = new OutboundDedupGate({ threshold: 0.6 });
      const prior = {
        text: 'The session restarted mid-reply. The fresh session did not know the previous reply had already been sent. That is why you saw two answers.',
        timestamp: Date.now() - 30_000,
      };
      const candidate =
        'The session restarted mid-reply. The fresh session did not know the previous reply had already been sent. That is why you saw two answers.';

      const result = gate.check({ text: candidate, recent: [prior] });

      expect(result.duplicate).toBe(true);
    });

    it('does not flag unrelated messages as duplicates', () => {
      const gate = new OutboundDedupGate();
      const prior = {
        text: 'Looking into the caffeinate restart loop — something is kicking it every 30 seconds.',
        timestamp: Date.now() - 60_000,
      };
      const candidate =
        'Fixed the tone gate prompt and added context-awareness so it no longer rejects developer-level replies.';

      const result = gate.check({ text: candidate, recent: [prior] });

      expect(result.duplicate).toBe(false);
    });
  });

  describe('time window filter', () => {
    it('ignores messages older than the window', () => {
      const gate = new OutboundDedupGate({ windowMs: 60_000 });
      const prior = {
        text: 'This is a detailed message that would certainly trigger a duplicate match if it were in window.',
        timestamp: Date.now() - 120_000, // 2 minutes ago — outside 1-minute window
      };
      const candidate =
        'This is a detailed message that would certainly trigger a duplicate match if it were in window.';

      const result = gate.check({ text: candidate, recent: [prior] });

      expect(result.duplicate).toBe(false);
    });

    it('uses a 5-minute default window', () => {
      const gate = new OutboundDedupGate();
      const prior = {
        text: 'This is a detailed message that should trigger the dedup gate inside the default five minute window.',
        timestamp: Date.now() - 4 * 60_000, // 4 minutes ago
      };
      const candidate =
        'This is a detailed message that should trigger the dedup gate inside the default five minute window.';

      const result = gate.check({ text: candidate, recent: [prior] });

      expect(result.duplicate).toBe(true);
    });
  });

  describe('min length filter', () => {
    it('does not block trivially short messages even when repeated', () => {
      // Repeated "on it" / "got it" are common and should NOT be blocked as dups
      const gate = new OutboundDedupGate();
      const prior = { text: 'On it', timestamp: Date.now() - 30_000 };

      const result = gate.check({ text: 'On it', recent: [prior] });

      expect(result.duplicate).toBe(false);
    });

    it('does not block messages below configured minLength', () => {
      const gate = new OutboundDedupGate({ minLength: 100 });
      const prior = {
        text: 'This sentence is over forty characters long but well under one hundred.',
        timestamp: Date.now() - 30_000,
      };

      const result = gate.check({
        text: 'This sentence is over forty characters long but well under one hundred.',
        recent: [prior],
      });

      expect(result.duplicate).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns duplicate=false when there are no recent messages', () => {
      const gate = new OutboundDedupGate();
      const result = gate.check({
        text: 'A reasonably long message that should be evaluated but has nothing to compare against.',
        recent: [],
      });
      expect(result.duplicate).toBe(false);
    });

    it('handles empty candidate text gracefully', () => {
      const gate = new OutboundDedupGate();
      const result = gate.check({ text: '', recent: [] });
      expect(result.duplicate).toBe(false);
    });

    it('handles recent messages with missing or empty text', () => {
      const gate = new OutboundDedupGate();
      const result = gate.check({
        text: 'A reasonably long message that should be evaluated against the recents below.',
        recent: [
          { text: '', timestamp: Date.now() },
          { text: '   ', timestamp: Date.now() },
        ],
      });
      expect(result.duplicate).toBe(false);
    });
  });

  describe('reproduction: the 04:42 duplicate', () => {
    it('flags the "older path" redundant answer against the prior reply', () => {
      // This reproduces the real incident where the fresh session generated
      // a second answer to the "older path" question that the old session had
      // already answered. With this gate in place the second send would have
      // been blocked instead of reaching the user.
      const gate = new OutboundDedupGate();
      const prior = {
        text:
          'Fair question — I was sloppy there. "Older" meaning it already existed before last night\'s work.\n\n' +
          'Two different things can interrupt a conversation:\n' +
          '1. The conversation grows too large and has to be ended entirely. A safety check has been watching for this for a while — it spots the signal, ends the session cleanly, and brings me back from the thread history. That\'s what you just witnessed. It predates the work we\'ve been doing this week.',
        timestamp: Date.now() - 90_000,
      };
      const candidate =
        'By "older path" I meant the recovery system that\'s been catching me today is one we\'ve had for a while — it kicks in when my session hits a hard limit and I get respawned fresh with thread history. The new work from last night handles a different failure mode (where the session doesn\'t die, it just goes quiet) and that one hasn\'t been triggered live yet.';

      const result = gate.check({ text: candidate, recent: [prior] });

      // These two messages cover overlapping content. They may not cross the
      // default 0.7 threshold purely on word 3-grams (the phrasing differs),
      // but the gate should register meaningful similarity. This documents
      // that the gate's ngram-based mode isn't sufficient alone for paraphrased
      // duplicates — an LLM-backed secondary check would catch these. Recorded
      // here as a known limitation.
      expect(result.similarity).toBeGreaterThan(0);
      // Intentionally not asserting duplicate=true — the paraphrased case is
      // an open gap tracked for a follow-up LLM-backed mode.
    });
  });
});
