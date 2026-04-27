/**
 * Unit tests for TopicSummarizer — LLM-powered rolling summary generation.
 *
 * Tests:
 * - Summary prompt building (with and without existing summary)
 * - Summary generation via mock intelligence provider
 * - Incremental summary updates
 * - Threshold-based trigger logic
 * - Force summarization
 * - Empty/invalid response handling
 * - Summarize-all across multiple topics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicSummarizer, buildSummaryPrompt } from '../../src/memory/TopicSummarizer.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

// Mock intelligence provider that captures prompts
function createMockIntelligence(response: string = 'Mock summary of the conversation.'): IntelligenceProvider & { _calls: Array<{ prompt: string; options?: IntelligenceOptions }> } {
  const calls: Array<{ prompt: string; options?: IntelligenceOptions }> = [];
  return {
    _calls: calls,
    evaluate: async (prompt: string, options?: IntelligenceOptions) => {
      calls.push({ prompt, options });
      return response;
    },
  };
}

describe('TopicSummarizer', () => {
  let tmpDir: string;
  let topicMemory: TopicMemory;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-summarizer-test-'));
    topicMemory = new TopicMemory(tmpDir);
    await topicMemory.open();
  });

  afterEach(() => {
    topicMemory.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: insert N messages into a topic
  function insertMessages(topicId: number, count: number) {
    for (let i = 0; i < count; i++) {
      topicMemory.insertMessage({
        messageId: i,
        topicId,
        text: `Message ${i} from ${i % 2 === 0 ? 'user' : 'agent'}`,
        fromUser: i % 2 === 0,
        timestamp: new Date(2026, 0, 1, 12, i).toISOString(),
        sessionName: i % 2 === 0 ? null : 'session-1',
      });
    }
  }

  describe('buildSummaryPrompt', () => {
    it('builds prompt for initial summary', () => {
      const messages = [
        { messageId: 1, topicId: 100, text: 'Hello', fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null },
        { messageId: 2, topicId: 100, text: 'Hi there', fromUser: false, timestamp: '2026-02-24T12:01:00Z', sessionName: null },
      ];

      const prompt = buildSummaryPrompt(messages, null, 'Dev Chat');
      expect(prompt).toContain('CONVERSATION TO SUMMARIZE');
      expect(prompt).toContain('Dev Chat');
      expect(prompt).toContain('User: Hello');
      expect(prompt).toContain('Agent: Hi there');
      expect(prompt).not.toContain('EXISTING SUMMARY');
    });

    it('builds prompt for incremental update', () => {
      const messages = [
        { messageId: 3, topicId: 100, text: 'New message', fromUser: true, timestamp: '2026-02-24T12:02:00Z', sessionName: null },
      ];

      const prompt = buildSummaryPrompt(messages, 'Previous summary content.', null);
      expect(prompt).toContain('EXISTING SUMMARY');
      expect(prompt).toContain('Previous summary content.');
      expect(prompt).toContain('NEW MESSAGES SINCE LAST SUMMARY');
      expect(prompt).toContain('New message');
    });

    it('truncates long messages', () => {
      const messages = [
        { messageId: 1, topicId: 100, text: 'x'.repeat(2000), fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null },
      ];

      const prompt = buildSummaryPrompt(messages, null, null);
      expect(prompt).toContain('...');
      // Should be truncated to ~1000 chars
      expect(prompt.length).toBeLessThan(3000);
    });
  });

  describe('summarize', () => {
    it('generates a summary when threshold is exceeded', async () => {
      insertMessages(100, 25);
      const intelligence = createMockIntelligence('Summary of 25 messages.');
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      const result = await summarizer.summarize(100);

      expect(result).not.toBeNull();
      expect(result!.summary).toBe('Summary of 25 messages.');
      expect(result!.messagesProcessed).toBe(25);
      expect(result!.isUpdate).toBe(false);
      expect(result!.durationMs).toBeGreaterThanOrEqual(0);

      // Verify summary was saved
      const saved = topicMemory.getTopicSummary(100);
      expect(saved).not.toBeNull();
      expect(saved!.summary).toBe('Summary of 25 messages.');
    });

    it('returns null when threshold is not exceeded', async () => {
      insertMessages(100, 5);
      const intelligence = createMockIntelligence();
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      const result = await summarizer.summarize(100);
      expect(result).toBeNull();
      expect(intelligence._calls).toHaveLength(0);
    });

    it('generates incremental update when summary exists', async () => {
      insertMessages(100, 50);
      topicMemory.saveTopicSummary(100, 'Old summary', 20, 19);

      const intelligence = createMockIntelligence('Updated summary.');
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      const result = await summarizer.summarize(100);

      expect(result).not.toBeNull();
      expect(result!.isUpdate).toBe(true);

      // Verify the prompt included the old summary
      expect(intelligence._calls[0].prompt).toContain('Old summary');
      expect(intelligence._calls[0].prompt).toContain('EXISTING SUMMARY');
    });

    it('forces summarization regardless of threshold', async () => {
      insertMessages(100, 3);
      const intelligence = createMockIntelligence('Forced summary.');
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      const result = await summarizer.summarize(100, true);

      expect(result).not.toBeNull();
      expect(result!.summary).toBe('Forced summary.');
    });

    it('uses fast (haiku) model tier', async () => {
      insertMessages(100, 25);
      const intelligence = createMockIntelligence();
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      await summarizer.summarize(100);

      expect(intelligence._calls[0].options?.model).toBe('fast');
    });

    it('throws on empty LLM response', async () => {
      insertMessages(100, 25);
      const intelligence = createMockIntelligence('');
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      await expect(summarizer.summarize(100)).rejects.toThrow('empty/invalid');
    });

    it('limits messages per prompt', async () => {
      insertMessages(100, 300);
      const intelligence = createMockIntelligence('Summary of limited messages.');
      const summarizer = new TopicSummarizer(intelligence, topicMemory, {
        messageThreshold: 20,
        maxMessagesPerPrompt: 50,
      });

      const result = await summarizer.summarize(100);

      // Should only process last 50, not all 300
      expect(result!.messagesProcessed).toBe(50);
    });
  });

  describe('summarizeAll', () => {
    it('summarizes all topics that need it', async () => {
      insertMessages(100, 25);
      insertMessages(200, 25);
      insertMessages(300, 5); // Below threshold

      const intelligence = createMockIntelligence('Comprehensive summary of the conversation between user and agent.');
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      const results = await summarizer.summarizeAll();

      expect(results).toHaveLength(2);
      expect(results.map(r => r.topicId).sort()).toEqual([100, 200]);
    });

    it('continues past individual failures', async () => {
      insertMessages(100, 25);
      insertMessages(200, 25);

      let callCount = 0;
      const intelligence: IntelligenceProvider = {
        evaluate: async () => {
          callCount++;
          if (callCount === 1) throw new Error('LLM failed');
          return 'Comprehensive summary of the conversation between user and agent.';
        },
      };
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      const results = await summarizer.summarizeAll();
      // One succeeded, one failed — only successful ones returned
      expect(results).toHaveLength(1);
    });
  });

  describe('needsUpdate', () => {
    it('delegates to topicMemory.needsSummaryUpdate', () => {
      insertMessages(100, 25);
      const intelligence = createMockIntelligence();
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      expect(summarizer.needsUpdate(100)).toBe(true);
      expect(summarizer.needsUpdate(200)).toBe(false); // No messages
    });
  });
});
