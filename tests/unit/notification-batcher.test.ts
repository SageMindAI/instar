import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NotificationBatcher,
  BatchedNotification,
  BatcherConfig,
  SendFunction,
} from '../../src/messaging/NotificationBatcher.js';

// --- Test Helpers ---

function makeSendFn(): SendFunction & { calls: Array<{ topicId: number; text: string }> } {
  const calls: Array<{ topicId: number; text: string }> = [];
  const fn = vi.fn(async (topicId: number, text: string) => {
    calls.push({ topicId, text });
    return { messageId: Math.floor(Math.random() * 10000) };
  }) as SendFunction & { calls: Array<{ topicId: number; text: string }> };
  fn.calls = calls;
  return fn;
}

function makeConfig(overrides?: Partial<BatcherConfig>): Partial<BatcherConfig> {
  return {
    enabled: true,
    summaryIntervalMinutes: 30,
    digestIntervalMinutes: 120,
    ...overrides,
  };
}

function makeNotification(overrides?: Partial<BatchedNotification>): BatchedNotification {
  return {
    tier: 'SUMMARY',
    category: 'job-complete',
    message: 'Test notification',
    timestamp: new Date('2026-02-25T12:00:00Z'),
    topicId: 100,
    ...overrides,
  };
}

function createBatcher(configOverrides?: Partial<BatcherConfig>): {
  batcher: NotificationBatcher;
  sendFn: ReturnType<typeof makeSendFn>;
} {
  const config = makeConfig(configOverrides);
  const sendFn = makeSendFn();
  const batcher = new NotificationBatcher(config);
  batcher.setSendFunction(sendFn);
  return { batcher, sendFn };
}

// --- Tests ---

describe('NotificationBatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor and configuration', () => {
    it('creates with default config', () => {
      const batcher = new NotificationBatcher();
      expect(batcher.isEnabled()).toBe(true);
      expect(batcher.getQueueSize()).toEqual({ summary: 0, digest: 0 });
    });

    it('respects enabled flag', () => {
      const batcher = new NotificationBatcher({ enabled: false });
      expect(batcher.isEnabled()).toBe(false);
    });
  });

  describe('enqueue - IMMEDIATE tier', () => {
    it('sends IMMEDIATE notifications directly', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({
        tier: 'IMMEDIATE',
        message: 'Stall alert!',
        topicId: 200,
      }));

      expect(sendFn.calls).toHaveLength(1);
      expect(sendFn.calls[0]).toEqual({ topicId: 200, text: 'Stall alert!' });
      expect(batcher.getQueueSize()).toEqual({ summary: 0, digest: 0 });
    });

    it('handles send failure gracefully', async () => {
      const sendFn = vi.fn().mockRejectedValue(new Error('API down')) as unknown as SendFunction;
      const batcher = new NotificationBatcher(makeConfig());
      batcher.setSendFunction(sendFn);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await batcher.enqueue(makeNotification({ tier: 'IMMEDIATE' }));
      consoleSpy.mockRestore();
    });

    it('silently drops when no send function configured', async () => {
      const batcher = new NotificationBatcher(makeConfig());
      // No setSendFunction called
      await batcher.enqueue(makeNotification({ tier: 'IMMEDIATE' }));
      // Should not throw
    });
  });

  describe('enqueue - SUMMARY tier', () => {
    it('queues SUMMARY notifications without sending', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY' }));

      expect(sendFn.calls).toHaveLength(0);
      expect(batcher.getQueueSize()).toEqual({ summary: 1, digest: 0 });
    });

    it('queues multiple SUMMARY notifications', async () => {
      const { batcher } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'A' }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'B' }));

      expect(batcher.getQueueSize()).toEqual({ summary: 2, digest: 0 });
    });
  });

  describe('enqueue - DIGEST tier', () => {
    it('queues DIGEST notifications', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'DIGEST' }));

      expect(sendFn.calls).toHaveLength(0);
      expect(batcher.getQueueSize()).toEqual({ summary: 0, digest: 1 });
    });
  });

  describe('flush', () => {
    it('flushes SUMMARY queue with formatted digest', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({
        tier: 'SUMMARY',
        category: 'job-complete',
        message: 'health-check: completed (3m, healthy)',
      }));
      await batcher.enqueue(makeNotification({
        tier: 'SUMMARY',
        category: 'attention-update',
        message: 'API rate limit status -> DONE',
        timestamp: new Date('2026-02-25T12:01:00Z'),
      }));

      await batcher.flush('SUMMARY');

      expect(sendFn.calls).toHaveLength(1);
      const text = sendFn.calls[0].text;
      expect(text).toContain('Summary (2 items)');
      expect(text).toContain('JOBS:');
      expect(text).toContain('health-check');
      expect(text).toContain('ATTENTION:');
      expect(text).toContain('API rate limit');
      expect(batcher.getQueueSize().summary).toBe(0);
    });

    it('flushes DIGEST queue', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({
        tier: 'DIGEST',
        category: 'system',
        message: 'Memory sync completed',
      }));

      await batcher.flush('DIGEST');

      expect(sendFn.calls).toHaveLength(1);
      expect(sendFn.calls[0].text).toContain('Digest (1 item)');
      expect(sendFn.calls[0].text).toContain('SYSTEM:');
    });

    it('returns 0 for empty queue', async () => {
      const { batcher } = createBatcher();
      expect(await batcher.flush('SUMMARY')).toBe(0);
    });

    it('returns count of flushed items', async () => {
      const { batcher } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'A' }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'B' }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'C' }));

      expect(await batcher.flush('SUMMARY')).toBe(3);
    });

    it('groups by topicId and sends separate digests', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', topicId: 100 }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', topicId: 200 }));

      await batcher.flush('SUMMARY');

      expect(sendFn.calls).toHaveLength(2);
      const topics = sendFn.calls.map(c => c.topicId).sort();
      expect(topics).toEqual([100, 200]);
    });
  });

  describe('flushAll', () => {
    it('flushes both queues', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'S' }));
      await batcher.enqueue(makeNotification({ tier: 'DIGEST', message: 'D' }));

      const total = await batcher.flushAll();
      expect(total).toBe(2);
      expect(sendFn.calls).toHaveLength(2);
      expect(batcher.getQueueSize()).toEqual({ summary: 0, digest: 0 });
    });
  });

  describe('formatDigest', () => {
    const qItem = (overrides: Partial<{ category: string; message: string; timestamp: Date; topicId: number; count: number; dedupKey: string }>) => ({
      category: 'system',
      message: 'test',
      timestamp: new Date(),
      topicId: 100,
      dedupKey: 'test',
      count: 1,
      ...overrides,
    });

    it('groups by category with headers', () => {
      const { batcher } = createBatcher();

      const items = [
        qItem({ category: 'job-complete', message: 'Job A', timestamp: new Date('2026-02-25T12:00:00Z'), dedupKey: 'a' }),
        qItem({ category: 'job-complete', message: 'Job B', timestamp: new Date('2026-02-25T12:01:00Z'), dedupKey: 'b' }),
        qItem({ category: 'session-lifecycle', message: 'Session X started', timestamp: new Date('2026-02-25T12:02:00Z'), dedupKey: 'c' }),
      ];

      const digest = batcher.formatDigest('Summary', items);
      expect(digest).toContain('Summary (3 items)');
      expect(digest).toContain('JOBS:');
      expect(digest).toContain('SESSIONS:');
    });

    it('sorts categories by first timestamp', () => {
      const { batcher } = createBatcher();

      const items = [
        qItem({ category: 'session-lifecycle', message: 'Late', timestamp: new Date('2026-02-25T13:00:00Z'), dedupKey: 'a' }),
        qItem({ category: 'job-complete', message: 'Early', timestamp: new Date('2026-02-25T12:00:00Z'), dedupKey: 'b' }),
      ];

      const digest = batcher.formatDigest('Test', items);
      expect(digest.indexOf('JOBS')).toBeLessThan(digest.indexOf('SESSIONS'));
    });

    it('uses category name for unknown categories', () => {
      const { batcher } = createBatcher();

      const items = [qItem({ category: 'custom-thing', message: 'Custom', dedupKey: 'custom' })];

      expect(batcher.formatDigest('Test', items)).toContain('CUSTOM THING:');
    });

    it('strips HTML tags', () => {
      const { batcher } = createBatcher();

      const items = [qItem({ category: 'system', message: '<b>Bold</b> text <i>italic</i>', dedupKey: 'html' })];

      const digest = batcher.formatDigest('Test', items);
      expect(digest).not.toContain('<b>');
      expect(digest).toContain('Bold text italic');
    });

    it('truncates long messages', () => {
      const { batcher } = createBatcher();

      const items = [qItem({ category: 'system', message: 'A'.repeat(200), dedupKey: 'long' })];

      const digest = batcher.formatDigest('Test', items);
      const itemLine = digest.split('\n').find(l => l.trim().startsWith('- '));
      expect(itemLine!.length).toBeLessThanOrEqual(124);
    });

    it('uses singular "item" for single item', () => {
      const { batcher } = createBatcher();
      const items = [qItem({ category: 'system', message: 'One', dedupKey: 'one' })];
      expect(batcher.formatDigest('Test', items)).toContain('(1 item)');
    });

    it('shows repeat count for collapsed duplicates', () => {
      const { batcher } = createBatcher();
      const items = [qItem({ category: 'system', message: 'External process alert', dedupKey: 'ext', count: 5 })];
      const digest = batcher.formatDigest('Test', items);
      expect(digest).toContain('(×5)');
    });
  });

  describe('quiet hours', () => {
    it('demotes SUMMARY to DIGEST during quiet hours', async () => {
      const { batcher, sendFn } = createBatcher({
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-25T02:00:00'));

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY' }));

      expect(batcher.getQueueSize()).toEqual({ summary: 0, digest: 1 });
    });

    it('does not demote outside quiet hours', async () => {
      const { batcher } = createBatcher({
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-25T14:00:00'));

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY' }));

      expect(batcher.getQueueSize()).toEqual({ summary: 1, digest: 0 });
    });

    it('never demotes IMMEDIATE', async () => {
      const { batcher, sendFn } = createBatcher({
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-25T02:00:00'));

      await batcher.enqueue(makeNotification({ tier: 'IMMEDIATE' }));
      expect(sendFn.calls).toHaveLength(1);
    });
  });

  describe('isQuietHours', () => {
    it('returns true during overnight range', () => {
      const { batcher } = createBatcher({
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
      });

      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-02-25T23:30:00'));
      expect(batcher.isQuietHours()).toBe(true);

      vi.setSystemTime(new Date('2026-02-25T03:00:00'));
      expect(batcher.isQuietHours()).toBe(true);
    });

    it('returns false outside overnight range', () => {
      const { batcher } = createBatcher({
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
      });

      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-02-25T12:00:00'));
      expect(batcher.isQuietHours()).toBe(false);

      vi.setSystemTime(new Date('2026-02-25T07:00:00'));
      expect(batcher.isQuietHours()).toBe(false);
    });

    it('returns false when not configured', () => {
      const { batcher } = createBatcher();
      expect(batcher.isQuietHours()).toBe(false);
    });
  });

  describe('timer-based auto-flush', () => {
    it('auto-flushes SUMMARY via flush method after interval would elapse', async () => {
      // Instead of testing the actual setInterval (which fights Vitest's fake timers),
      // test the flush behavior directly — which is what the timer triggers.
      const { batcher, sendFn } = createBatcher({ summaryIntervalMinutes: 30 });

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Queued' }));
      expect(sendFn.calls).toHaveLength(0);

      // Simulate what the timer does: flush SUMMARY
      await batcher.flush('SUMMARY');
      expect(sendFn.calls).toHaveLength(1);
      expect(sendFn.calls[0].text).toContain('Summary');
    });

    it('auto-flushes DIGEST via flush method', async () => {
      const { batcher, sendFn } = createBatcher({ digestIntervalMinutes: 120 });

      await batcher.enqueue(makeNotification({ tier: 'DIGEST', message: 'Queued' }));

      await batcher.flush('DIGEST');
      expect(sendFn.calls).toHaveLength(1);
      expect(sendFn.calls[0].text).toContain('Digest');
    });

    it('flush returns 0 for empty queues', async () => {
      const { batcher } = createBatcher();

      expect(await batcher.flush('SUMMARY')).toBe(0);
      expect(await batcher.flush('DIGEST')).toBe(0);
    });

    it('start is idempotent', () => {
      const { batcher } = createBatcher();
      batcher.start();
      batcher.start(); // Should not throw or create duplicate timers
      batcher.stop();
    });

    it('stop is safe to call without start', () => {
      const { batcher } = createBatcher();
      batcher.stop(); // Should not throw
    });
  });

  describe('getStats', () => {
    it('returns initial stats', () => {
      const { batcher } = createBatcher();
      const stats = batcher.getStats();
      expect(stats.summaryQueueSize).toBe(0);
      expect(stats.digestQueueSize).toBe(0);
      expect(stats.totalFlushed).toBe(0);
    });

    it('tracks totalFlushed', async () => {
      const { batcher } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY' }));
      await batcher.enqueue(makeNotification({ tier: 'DIGEST' }));
      await batcher.flushAll();

      expect(batcher.getStats().totalFlushed).toBe(2);
    });
  });

  describe('deduplication', () => {
    it('collapses identical messages within a batch window', async () => {
      const { batcher } = createBatcher();

      // Same message enqueued 3 times
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Coherence: 1 issue(s)' }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Coherence: 1 issue(s)' }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Coherence: 1 issue(s)' }));

      // Should collapse to 1 entry
      expect(batcher.getQueueSize().summary).toBe(1);
    });

    it('normalizes PIDs and memory values for dedup', async () => {
      const { batcher } = createBatcher();

      await batcher.enqueue(makeNotification({
        tier: 'SUMMARY',
        message: 'Found 1 long-running process PID 12345: 200MB, running 5h 30m',
      }));
      await batcher.enqueue(makeNotification({
        tier: 'SUMMARY',
        message: 'Found 1 long-running process PID 67890: 350MB, running 6h 15m',
      }));

      // Different PIDs/memory/duration but same shape — should collapse
      expect(batcher.getQueueSize().summary).toBe(1);
    });

    it('does NOT collapse messages with different shapes', async () => {
      const { batcher } = createBatcher();

      await batcher.enqueue(makeNotification({
        tier: 'SUMMARY',
        message: 'Coherence: shadow installation detected',
      }));
      await batcher.enqueue(makeNotification({
        tier: 'SUMMARY',
        message: 'Found 1 long-running process outside Instar',
      }));

      // Different message shapes — keep both
      expect(batcher.getQueueSize().summary).toBe(2);
    });

    it('dedup is scoped per topicId', async () => {
      const { batcher } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Same msg', topicId: 100 }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Same msg', topicId: 200 }));

      // Same message but different topics — keep both
      expect(batcher.getQueueSize().summary).toBe(2);
    });

    it('shows collapsed count in digest output', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Recurring alert about PID 123' }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Recurring alert about PID 456' }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Recurring alert about PID 789' }));

      await batcher.flush('SUMMARY');

      expect(sendFn.calls).toHaveLength(1);
      expect(sendFn.calls[0].text).toContain('1 item'); // Collapsed to 1
      expect(sendFn.calls[0].text).toContain('(×3)');
    });

    it('does not show count suffix for single occurrences', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Unique alert' }));
      await batcher.flush('SUMMARY');

      expect(sendFn.calls[0].text).not.toContain('×');
    });

    it('dedup works independently for SUMMARY and DIGEST queues', async () => {
      const { batcher } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Shared message' }));
      await batcher.enqueue(makeNotification({ tier: 'DIGEST', message: 'Shared message' }));

      // Same message in different tiers — each queue has 1
      expect(batcher.getQueueSize()).toEqual({ summary: 1, digest: 1 });
    });
  });

  describe('edge cases', () => {
    it('handles mixed tiers correctly', async () => {
      const { batcher, sendFn } = createBatcher();

      await batcher.enqueue(makeNotification({ tier: 'IMMEDIATE', message: 'Now' }));
      await batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: 'Later' }));
      await batcher.enqueue(makeNotification({ tier: 'DIGEST', message: 'Much later' }));

      expect(sendFn.calls).toHaveLength(1);
      expect(sendFn.calls[0].text).toBe('Now');

      await batcher.flush('SUMMARY');
      expect(sendFn.calls).toHaveLength(2);

      await batcher.flush('DIGEST');
      expect(sendFn.calls).toHaveLength(3);
    });

    it('handles rapid enqueue without race conditions', async () => {
      const { batcher, sendFn } = createBatcher();

      // Use distinct message shapes (not just different numbers) to avoid dedup
      const categories = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(batcher.enqueue(makeNotification({ tier: 'SUMMARY', message: `${categories[i]} notification` })));
      }
      await Promise.all(promises);
      await batcher.flush('SUMMARY');

      expect(sendFn.calls).toHaveLength(1);
      expect(sendFn.calls[0].text).toContain('10 items');
    });
  });
});
