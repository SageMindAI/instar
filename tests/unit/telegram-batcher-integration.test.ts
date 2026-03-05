/**
 * Tests for TelegramAdapter + NotificationBatcher integration.
 *
 * Verifies: notifyTopic routing, configureBatcher wiring,
 * /flush command, graceful shutdown flush, getBatcher accessor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationBatcher } from '../../src/messaging/NotificationBatcher.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

describe('TelegramAdapter + NotificationBatcher', () => {
  let project: TempProject;
  let adapter: TelegramAdapter;
  let sentMessages: Array<{ topicId: number; text: string }>;

  const fakeConfig = {
    token: 'fake-bot-token',
    chatId: '-1001234567890',
    pollIntervalMs: 60000,
  };

  beforeEach(() => {
    project = createTempProject();
    adapter = new TelegramAdapter(fakeConfig, project.stateDir);
    sentMessages = [];

    // Stub sendToTopic to avoid real API calls
    vi.spyOn(adapter, 'sendToTopic').mockImplementation(async (topicId: number, text: string) => {
      sentMessages.push({ topicId, text });
      return { messageId: sentMessages.length, topicId };
    });
  });

  afterEach(() => {
    project.cleanup();
    vi.restoreAllMocks();
  });

  // ── configureBatcher ──────────────────────────────────

  describe('configureBatcher', () => {
    it('returns a NotificationBatcher instance', () => {
      const batcher = adapter.configureBatcher();
      expect(batcher).toBeInstanceOf(NotificationBatcher);
    });

    it('getBatcher returns null before configuration', () => {
      expect(adapter.getBatcher()).toBeNull();
    });

    it('getBatcher returns batcher after configuration', () => {
      const batcher = adapter.configureBatcher();
      expect(adapter.getBatcher()).toBe(batcher);
    });

    it('accepts custom interval config', () => {
      const batcher = adapter.configureBatcher({
        summaryIntervalMinutes: 15,
        digestIntervalMinutes: 60,
      });
      expect(batcher.isEnabled()).toBe(true);
    });

    it('wires sendToTopic as the batcher send function', async () => {
      adapter.configureBatcher();
      const batcher = adapter.getBatcher()!;

      // Enqueue an IMMEDIATE notification — should pass through to sendToTopic
      await batcher.enqueue({
        tier: 'IMMEDIATE',
        category: 'test',
        message: 'Direct message',
        timestamp: new Date(),
        topicId: 100,
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({ topicId: 100, text: 'Direct message' });
    });
  });

  // ── notifyTopic ──────────────────────────────────────

  describe('notifyTopic', () => {
    it('sends IMMEDIATE notifications directly when batcher is configured', async () => {
      adapter.configureBatcher();
      await adapter.notifyTopic(42, 'Alert!', 'IMMEDIATE', 'ops-alert');

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({ topicId: 42, text: 'Alert!' });
    });

    it('queues SUMMARY notifications in the batcher', async () => {
      adapter.configureBatcher();
      await adapter.notifyTopic(42, 'Job done', 'SUMMARY', 'job-complete');

      // Nothing sent yet — it's queued
      expect(sentMessages).toHaveLength(0);

      const batcher = adapter.getBatcher()!;
      const sizes = batcher.getQueueSize();
      expect(sizes.summary).toBe(1);
    });

    it('queues DIGEST notifications in the batcher', async () => {
      adapter.configureBatcher();
      await adapter.notifyTopic(42, 'System ok', 'DIGEST', 'system');

      expect(sentMessages).toHaveLength(0);

      const batcher = adapter.getBatcher()!;
      const sizes = batcher.getQueueSize();
      expect(sizes.digest).toBe(1);
    });

    it('falls back to direct send when no batcher is configured', async () => {
      // No configureBatcher call
      await adapter.notifyTopic(42, 'Fallback message', 'SUMMARY', 'test');

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({ topicId: 42, text: 'Fallback message' });
    });

    it('queued SUMMARY notifications appear in flush', async () => {
      adapter.configureBatcher();

      await adapter.notifyTopic(42, 'Job A done', 'SUMMARY', 'job-complete');
      await adapter.notifyTopic(42, 'Job B done', 'SUMMARY', 'job-complete');
      await adapter.notifyTopic(42, 'Session started', 'SUMMARY', 'session-lifecycle');

      expect(sentMessages).toHaveLength(0);

      const batcher = adapter.getBatcher()!;
      const flushed = await batcher.flush('SUMMARY');
      expect(flushed).toBe(3);

      // One digest message sent (all same topicId = grouped)
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].topicId).toBe(42);
      expect(sentMessages[0].text).toContain('Job A done');
      expect(sentMessages[0].text).toContain('Job B done');
    });

    it('groups notifications by topicId in flush', async () => {
      adapter.configureBatcher();

      await adapter.notifyTopic(10, 'Message for topic 10', 'SUMMARY', 'system');
      await adapter.notifyTopic(20, 'Message for topic 20', 'SUMMARY', 'system');

      const batcher = adapter.getBatcher()!;
      await batcher.flush('SUMMARY');

      // Two separate digest messages — one per topic
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages.map(m => m.topicId).sort()).toEqual([10, 20]);
    });
  });

  // ── /flush command ──────────────────────────────────

  describe('/flush command', () => {
    it('flushes batched notifications and reports count', async () => {
      adapter.configureBatcher();

      // Queue some notifications
      await adapter.notifyTopic(42, 'Job done', 'SUMMARY', 'job-complete');
      await adapter.notifyTopic(42, 'System notice', 'DIGEST', 'system');

      // Simulate /flush command via handleCommand (private — use the adapter's internal flow)
      // We access handleCommand through the message flow
      const handleCommand = (adapter as any).handleCommand.bind(adapter);
      const handled = await handleCommand('/flush', 42, 123);

      expect(handled).toBe(true);
      // Should have: 1 summary digest + 1 digest digest + 1 "Flushed X" confirmation
      expect(sentMessages.some(m => m.text.includes('Flushed 2 batched notifications'))).toBe(true);
    });

    it('reports empty queue when nothing to flush', async () => {
      adapter.configureBatcher();

      const handleCommand = (adapter as any).handleCommand.bind(adapter);
      const handled = await handleCommand('/flush', 42, 123);

      expect(handled).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('No batched notifications');
    });

    it('falls back to onFlushNotifications callback when no batcher', async () => {
      let calledWith: number | null = null;
      adapter.onFlushNotifications = async (topicId) => {
        calledWith = topicId;
      };

      const handleCommand = (adapter as any).handleCommand.bind(adapter);
      const handled = await handleCommand('/flush', 42, 123);

      expect(handled).toBe(true);
      expect(calledWith).toBe(42);
    });

    it('reports not enabled when no batcher and no callback', async () => {
      const handleCommand = (adapter as any).handleCommand.bind(adapter);
      const handled = await handleCommand('/flush', 42, 123);

      expect(handled).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('not enabled');
    });
  });

  // ── Graceful shutdown ──────────────────────────────────

  describe('graceful shutdown', () => {
    it('flushes batcher on stop', async () => {
      adapter.configureBatcher();

      // Queue a SUMMARY notification
      await adapter.notifyTopic(42, 'Last message', 'SUMMARY', 'system');
      expect(sentMessages).toHaveLength(0);

      // Stop the adapter — should flush
      await adapter.stop();

      // The digest message should have been sent
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].topicId).toBe(42);
      expect(sentMessages[0].text).toContain('Last message');
    });

    it('does not crash stop if batcher flush fails', async () => {
      adapter.configureBatcher();
      const batcher = adapter.getBatcher()!;

      // Break the send function
      batcher.setSendFunction(async () => {
        throw new Error('Network failure');
      });

      await adapter.notifyTopic(42, 'Will fail', 'SUMMARY', 'system');

      // Should not throw
      await expect(adapter.stop()).resolves.toBeUndefined();
    });

    it('stop works fine without batcher', async () => {
      // No configureBatcher call
      await expect(adapter.stop()).resolves.toBeUndefined();
    });
  });

  // ── Batcher stats accessibility ──────────────────────────

  describe('batcher stats', () => {
    it('exposes queue stats through getBatcher', async () => {
      adapter.configureBatcher();

      await adapter.notifyTopic(42, 'A', 'SUMMARY', 'system');
      await adapter.notifyTopic(42, 'B', 'SUMMARY', 'system');
      await adapter.notifyTopic(42, 'C', 'DIGEST', 'system');

      const stats = adapter.getBatcher()!.getStats();
      expect(stats.summaryQueueSize).toBe(2);
      expect(stats.digestQueueSize).toBe(1);
      expect(stats.totalFlushed).toBe(0);
    });

    it('updates stats after flush', async () => {
      adapter.configureBatcher();

      await adapter.notifyTopic(42, 'A', 'SUMMARY', 'system');
      await adapter.notifyTopic(42, 'B', 'DIGEST', 'system');

      const batcher = adapter.getBatcher()!;
      await batcher.flushAll();

      const stats = batcher.getStats();
      expect(stats.summaryQueueSize).toBe(0);
      expect(stats.digestQueueSize).toBe(0);
      expect(stats.totalFlushed).toBe(2);
    });
  });
});
