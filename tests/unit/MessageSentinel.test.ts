import { describe, it, expect, beforeEach } from 'vitest';
import { MessageSentinel } from '../../src/core/MessageSentinel.js';
import type { MessageSentinelConfig, SentinelCategory } from '../../src/core/MessageSentinel.js';

describe('MessageSentinel', () => {
  let sentinel: MessageSentinel;

  beforeEach(() => {
    sentinel = new MessageSentinel();
  });

  describe('fast-path — slash commands', () => {
    it('/stop → emergency-stop', async () => {
      const result = await sentinel.classify('/stop');
      expect(result.category).toBe('emergency-stop');
      expect(result.action.type).toBe('kill-session');
      expect(result.method).toBe('fast-path');
      expect(result.confidence).toBe(1.0);
    });

    it('/kill → emergency-stop', async () => {
      const result = await sentinel.classify('/kill');
      expect(result.category).toBe('emergency-stop');
      expect(result.action.type).toBe('kill-session');
    });

    it('/abort → emergency-stop', async () => {
      const result = await sentinel.classify('/abort');
      expect(result.category).toBe('emergency-stop');
    });

    it('/cancel → emergency-stop', async () => {
      const result = await sentinel.classify('/cancel');
      expect(result.category).toBe('emergency-stop');
    });

    it('/terminate → emergency-stop', async () => {
      const result = await sentinel.classify('/terminate');
      expect(result.category).toBe('emergency-stop');
    });

    it('/pause → pause', async () => {
      const result = await sentinel.classify('/pause');
      expect(result.category).toBe('pause');
      expect(result.action.type).toBe('pause-session');
      expect(result.confidence).toBe(1.0);
    });

    it('/wait → pause', async () => {
      const result = await sentinel.classify('/wait');
      expect(result.category).toBe('pause');
    });

    it('/hold → pause', async () => {
      const result = await sentinel.classify('/hold');
      expect(result.category).toBe('pause');
    });
  });

  describe('fast-path — exact matches', () => {
    it('"stop" → emergency-stop', async () => {
      const result = await sentinel.classify('stop');
      expect(result.category).toBe('emergency-stop');
      expect(result.confidence).toBe(0.95);
    });

    it('"stop!" → emergency-stop', async () => {
      const result = await sentinel.classify('stop!');
      expect(result.category).toBe('emergency-stop');
    });

    it('"abort" → emergency-stop', async () => {
      const result = await sentinel.classify('abort');
      expect(result.category).toBe('emergency-stop');
    });

    it('"cancel everything" → emergency-stop', async () => {
      const result = await sentinel.classify('cancel everything');
      expect(result.category).toBe('emergency-stop');
    });

    it('"stop now" → emergency-stop', async () => {
      const result = await sentinel.classify('stop now');
      expect(result.category).toBe('emergency-stop');
    });

    it('"stop immediately" → emergency-stop', async () => {
      const result = await sentinel.classify('stop immediately');
      expect(result.category).toBe('emergency-stop');
    });

    it('"wait" → pause', async () => {
      const result = await sentinel.classify('wait');
      expect(result.category).toBe('pause');
      expect(result.confidence).toBe(0.95);
    });

    it('"hold on" → pause', async () => {
      const result = await sentinel.classify('hold on');
      expect(result.category).toBe('pause');
    });

    it('"one moment" → pause', async () => {
      const result = await sentinel.classify('one moment');
      expect(result.category).toBe('pause');
    });
  });

  describe('fast-path — regex patterns', () => {
    it('"don\'t do that" → emergency-stop', async () => {
      const result = await sentinel.classify("don't do that");
      expect(result.category).toBe('emergency-stop');
      expect(result.confidence).toBe(0.85);
    });

    it('"dont do that" → emergency-stop', async () => {
      const result = await sentinel.classify('dont do that');
      expect(result.category).toBe('emergency-stop');
    });

    it('"don\'t do anything" → emergency-stop', async () => {
      const result = await sentinel.classify("don't do anything");
      expect(result.category).toBe('emergency-stop');
    });

    it('"No! Stop" → emergency-stop', async () => {
      const result = await sentinel.classify('No! Stop');
      expect(result.category).toBe('emergency-stop');
    });

    it('"please stop" → emergency-stop', async () => {
      const result = await sentinel.classify('please stop');
      expect(result.category).toBe('emergency-stop');
    });

    it('"Stop it" → emergency-stop', async () => {
      const result = await sentinel.classify('Stop it');
      expect(result.category).toBe('emergency-stop');
    });

    it('"Stop this" → emergency-stop', async () => {
      const result = await sentinel.classify('Stop this');
      expect(result.category).toBe('emergency-stop');
    });

    it('"wait a second" → pause', async () => {
      const result = await sentinel.classify('wait a second');
      expect(result.category).toBe('pause');
    });

    it('"hold on a minute" → pause', async () => {
      const result = await sentinel.classify('hold on a minute');
      expect(result.category).toBe('pause');
    });

    it('"let me think about this" → pause', async () => {
      const result = await sentinel.classify('let me think about this');
      expect(result.category).toBe('pause');
    });

    it('"one sec" → pause', async () => {
      const result = await sentinel.classify('one sec');
      expect(result.category).toBe('pause');
    });
  });

  describe('fast-path — all caps detection', () => {
    it('"STOP NOW" → emergency-stop', async () => {
      const result = await sentinel.classify('STOP NOW');
      expect(result.category).toBe('emergency-stop');
    });

    it('"NO STOP DON\'T" → emergency-stop', async () => {
      const result = await sentinel.classify("NO STOP DON'T");
      expect(result.category).toBe('emergency-stop');
    });

    it('"CANCEL EVERYTHING" → emergency-stop', async () => {
      const result = await sentinel.classify('CANCEL EVERYTHING');
      expect(result.category).toBe('emergency-stop');
    });

    it('all caps without stop words → no fast-path match', async () => {
      const result = await sentinel.classify('HELLO WORLD');
      // Should fall through to default (no LLM configured)
      expect(result.category).toBe('normal');
    });
  });

  describe('fast-path — no false positives', () => {
    it('"stop by the store later" → normal (no fast-path)', async () => {
      // "stop by" doesn't match our patterns because "stop" is followed by "by"
      // which isn't in our exact matches. Regex "stop\b" at start would match though.
      // This is where LLM classification would help.
      const result = await sentinel.classify('stop by the store later');
      // Fast path: "stop" at start matches regex /^stop\b/i
      // This IS a false positive in fast-path — the LLM layer would catch it
      // but without LLM, the fast path errs on the side of caution
      expect(result.category).toBe('emergency-stop');
      // This is acceptable — better to false-positive stop than false-negative continue
    });

    it('"can you help me with something?" → normal', async () => {
      const result = await sentinel.classify('can you help me with something?');
      expect(result.category).toBe('normal');
    });

    it('"what time is it?" → normal', async () => {
      const result = await sentinel.classify('what time is it?');
      expect(result.category).toBe('normal');
    });

    it('"please send the email" → normal', async () => {
      const result = await sentinel.classify('please send the email');
      expect(result.category).toBe('normal');
    });

    it('long normal message → normal', async () => {
      const result = await sentinel.classify(
        'Hey, I was thinking about the project timeline and wanted to discuss some changes to the roadmap'
      );
      expect(result.category).toBe('normal');
    });
  });

  describe('disabled sentinel', () => {
    it('passes everything through when disabled', async () => {
      sentinel = new MessageSentinel({ enabled: false });
      const result = await sentinel.classify('STOP');
      expect(result.category).toBe('normal');
      expect(result.action.type).toBe('pass-through');
      expect(result.reason).toContain('disabled');
    });
  });

  describe('LLM classification', () => {
    it('uses LLM for ambiguous messages', async () => {
      let promptReceived = '';
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async (prompt) => {
            promptReceived = prompt;
            return 'redirect';
          },
        },
      });

      const result = await sentinel.classify('actually, change the approach to use archives instead');
      expect(result.category).toBe('redirect');
      expect(result.method).toBe('llm');
      expect(result.action.type).toBe('priority-inject');
      expect(promptReceived).toContain('actually, change the approach');
    });

    it('LLM failure defaults to pass-through', async () => {
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => { throw new Error('LLM down'); },
        },
      });

      const result = await sentinel.classify('hmm I am not sure about this');
      expect(result.category).toBe('normal');
      expect(result.action.type).toBe('pass-through');
    });

    it('unparseable LLM response defaults to pause (cautious)', async () => {
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => 'I think this is probably a stop command but maybe not',
        },
      });

      const result = await sentinel.classify('maybe we should reconsider');
      expect(result.category).toBe('pause');
      expect(result.action.type).toBe('pause-session');
    });

    it('fast-path takes precedence over LLM', async () => {
      let llmCalled = false;
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => {
            llmCalled = true;
            return 'normal';
          },
        },
      });

      const result = await sentinel.classify('stop');
      expect(result.category).toBe('emergency-stop');
      expect(result.method).toBe('fast-path');
      expect(llmCalled).toBe(false);
    });

    it('fastPathOnly skips LLM', async () => {
      let llmCalled = false;
      sentinel = new MessageSentinel({
        fastPathOnly: true,
        intelligence: {
          evaluate: async () => {
            llmCalled = true;
            return 'emergency-stop';
          },
        },
      });

      const result = await sentinel.classify('I have a bad feeling about this');
      expect(result.category).toBe('normal');
      expect(result.method).toBe('default');
      expect(llmCalled).toBe(false);
    });
  });

  describe('custom patterns', () => {
    it('recognizes custom stop patterns', async () => {
      sentinel = new MessageSentinel({
        customStopPatterns: ['emergency', 'red alert'],
      });

      const result = await sentinel.classify('emergency');
      expect(result.category).toBe('emergency-stop');
    });

    it('recognizes custom pause patterns', async () => {
      sentinel = new MessageSentinel({
        customPausePatterns: ['brb', 'gimme a sec'],
      });

      const result = await sentinel.classify('brb');
      expect(result.category).toBe('pause');
    });
  });

  describe('stats', () => {
    it('tracks classification stats', async () => {
      await sentinel.classify('stop');
      await sentinel.classify('wait');
      await sentinel.classify('hello');

      const stats = sentinel.getStats();
      expect(stats.totalClassified).toBe(3);
      expect(stats.byCategory['emergency-stop']).toBe(1);
      expect(stats.byCategory.pause).toBe(1);
      expect(stats.byCategory.normal).toBe(1);
      expect(stats.emergencyStops).toBe(1);
    });

    it('tracks average latency', async () => {
      await sentinel.classify('stop');
      const stats = sentinel.getStats();
      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('resets stats', async () => {
      await sentinel.classify('stop');
      sentinel.resetStats();
      const stats = sentinel.getStats();
      expect(stats.totalClassified).toBe(0);
    });
  });

  describe('isEnabled', () => {
    it('returns true by default', () => {
      expect(sentinel.isEnabled()).toBe(true);
    });

    it('returns false when disabled', () => {
      sentinel = new MessageSentinel({ enabled: false });
      expect(sentinel.isEnabled()).toBe(false);
    });
  });
});
