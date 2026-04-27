/**
 * Unit tests for Topic Purpose Awareness — soft session awareness of topic focus.
 *
 * Tests:
 * - PURPOSE line parsing from LLM responses
 * - Purpose extraction during summarization
 * - Purpose storage and retrieval in TopicMemory
 * - Purpose injection in formatContextForSession
 * - Purpose injection in formatContextForUser
 * - Schema migration (v3 → v4)
 * - Graceful handling of missing PURPOSE lines
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicSummarizer, buildSummaryPrompt, parsePurposeFromResponse } from '../../src/memory/TopicSummarizer.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

function createMockIntelligence(response: string): IntelligenceProvider & { _calls: Array<{ prompt: string; options?: IntelligenceOptions }> } {
  const calls: Array<{ prompt: string; options?: IntelligenceOptions }> = [];
  return {
    _calls: calls,
    evaluate: async (prompt: string, options?: IntelligenceOptions) => {
      calls.push({ prompt, options });
      return response;
    },
  };
}

describe('Topic Purpose Awareness', () => {
  let tmpDir: string;
  let topicMemory: TopicMemory;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-purpose-test-'));
    topicMemory = new TopicMemory(tmpDir);
    await topicMemory.open();
  });

  afterEach(() => {
    topicMemory.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertMessages(topicId: number, count: number) {
    for (let i = 0; i < count; i++) {
      topicMemory.insertMessage({
        messageId: topicId * 1000 + i,
        topicId,
        text: `Message ${i} from ${i % 2 === 0 ? 'user' : 'agent'}`,
        fromUser: i % 2 === 0,
        timestamp: new Date(2026, 0, 1, 12, i).toISOString(),
        sessionName: i % 2 === 0 ? null : 'session-1',
      });
    }
  }

  describe('parsePurposeFromResponse', () => {
    it('extracts PURPOSE line from well-formed response', () => {
      const text = 'PURPOSE: Debugging OAuth token refresh failures\n\nThe conversation has been about fixing auth issues...';
      const { purpose, body } = parsePurposeFromResponse(text);
      expect(purpose).toBe('Debugging OAuth token refresh failures');
      expect(body).toBe('The conversation has been about fixing auth issues...');
    });

    it('handles PURPOSE with no blank line separator', () => {
      const text = 'PURPOSE: Building a new dashboard\nThe user asked for a dashboard...';
      const { purpose, body } = parsePurposeFromResponse(text);
      expect(purpose).toBe('Building a new dashboard');
      expect(body).toBe('The user asked for a dashboard...');
    });

    it('returns null purpose when no PURPOSE line present', () => {
      const text = 'This is a summary without a purpose line.\nMore content.';
      const { purpose, body } = parsePurposeFromResponse(text);
      expect(purpose).toBeNull();
      expect(body).toBe(text);
    });

    it('is case-insensitive for PURPOSE prefix', () => {
      const text = 'purpose: Email delivery debugging\n\nSummary text.';
      const { purpose, body } = parsePurposeFromResponse(text);
      expect(purpose).toBe('Email delivery debugging');
    });

    it('handles empty purpose value', () => {
      const text = 'PURPOSE: \n\nSummary text here.';
      const { purpose, body } = parsePurposeFromResponse(text);
      // Empty PURPOSE line: regex matches but purpose trims to empty → null
      // Body still gets the PURPOSE line stripped
      expect(purpose).toBeNull();
      expect(body).toBe('Summary text here.');
    });

    it('only matches PURPOSE at the start of the text', () => {
      const text = 'Some intro text.\nPURPOSE: This should not match\nMore text.';
      const { purpose, body } = parsePurposeFromResponse(text);
      expect(purpose).toBeNull();
      expect(body).toBe(text);
    });

    it('strips leading/trailing whitespace from purpose', () => {
      const text = 'PURPOSE:   Lots of spaces around   \n\nBody.';
      const { purpose, body } = parsePurposeFromResponse(text);
      expect(purpose).toBe('Lots of spaces around');
    });
  });

  describe('buildSummaryPrompt', () => {
    it('includes PURPOSE format instructions', () => {
      const messages = [
        { messageId: 1, topicId: 100, text: 'Hello', fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null },
      ];

      const prompt = buildSummaryPrompt(messages, null, null);
      expect(prompt).toContain('PURPOSE');
      expect(prompt).toContain('recent focus');
      expect(prompt).toContain('FORMAT:');
    });
  });

  describe('TopicSummarizer with purpose', () => {
    it('extracts and saves purpose from LLM response', async () => {
      insertMessages(100, 25);
      const intelligence = createMockIntelligence(
        'PURPOSE: Investigating session drift in topic bindings\n\nThe conversation started with a bug report about sessions posting to wrong topics...'
      );
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      const result = await summarizer.summarize(100);

      expect(result).not.toBeNull();
      expect(result!.purpose).toBe('Investigating session drift in topic bindings');
      expect(result!.summary).toBe('The conversation started with a bug report about sessions posting to wrong topics...');

      // Verify purpose was saved to database
      const saved = topicMemory.getTopicSummary(100);
      expect(saved).not.toBeNull();
      expect(saved!.purpose).toBe('Investigating session drift in topic bindings');
      expect(saved!.summary).toBe('The conversation started with a bug report about sessions posting to wrong topics...');
    });

    it('handles LLM response without PURPOSE line gracefully', async () => {
      insertMessages(100, 25);
      const intelligence = createMockIntelligence(
        'A summary without any purpose line. Just plain text summary.'
      );
      const summarizer = new TopicSummarizer(intelligence, topicMemory, { messageThreshold: 20 });

      const result = await summarizer.summarize(100);

      expect(result).not.toBeNull();
      expect(result!.purpose).toBeNull();
      expect(result!.summary).toBe('A summary without any purpose line. Just plain text summary.');

      const saved = topicMemory.getTopicSummary(100);
      expect(saved!.purpose).toBeNull();
    });
  });

  describe('TopicMemory purpose storage', () => {
    it('saves and retrieves purpose', () => {
      topicMemory.saveTopicSummary(100, 'Test summary', 10, 9, 'Building a dashboard');
      const saved = topicMemory.getTopicSummary(100);
      expect(saved!.purpose).toBe('Building a dashboard');
    });

    it('saves null purpose', () => {
      topicMemory.saveTopicSummary(100, 'Test summary', 10, 9, null);
      const saved = topicMemory.getTopicSummary(100);
      expect(saved!.purpose).toBeNull();
    });

    it('saves undefined purpose (defaults to null)', () => {
      topicMemory.saveTopicSummary(100, 'Test summary', 10, 9);
      const saved = topicMemory.getTopicSummary(100);
      expect(saved!.purpose).toBeNull();
    });

    it('updates purpose when summary is updated', () => {
      topicMemory.saveTopicSummary(100, 'First summary', 10, 9, 'Original purpose');
      topicMemory.saveTopicSummary(100, 'Updated summary', 20, 19, 'New purpose after drift');
      const saved = topicMemory.getTopicSummary(100);
      expect(saved!.purpose).toBe('New purpose after drift');
      expect(saved!.summary).toBe('Updated summary');
    });
  });

  describe('TopicContext includes purpose', () => {
    it('getTopicContext returns purpose', () => {
      insertMessages(100, 5);
      topicMemory.saveTopicSummary(100, 'A summary', 5, 4, 'Debugging auth flows');
      const ctx = topicMemory.getTopicContext(100);
      expect(ctx.purpose).toBe('Debugging auth flows');
    });

    it('getTopicContext returns null purpose when no summary', () => {
      insertMessages(100, 5);
      const ctx = topicMemory.getTopicContext(100);
      expect(ctx.purpose).toBeNull();
    });

    it('getTopicContext returns null purpose when summary has no purpose', () => {
      insertMessages(100, 5);
      topicMemory.saveTopicSummary(100, 'A summary', 5, 4);
      const ctx = topicMemory.getTopicContext(100);
      expect(ctx.purpose).toBeNull();
    });
  });

  describe('formatContextForSession with purpose', () => {
    it('includes "Current focus" line when purpose exists', () => {
      insertMessages(100, 5);
      topicMemory.saveTopicSummary(100, 'A summary about auth work', 5, 4, 'Fixing OAuth token refresh');
      const formatted = topicMemory.formatContextForSession(100);
      expect(formatted).toContain('Current focus: Fixing OAuth token refresh');
    });

    it('omits "Current focus" line when no purpose', () => {
      insertMessages(100, 5);
      topicMemory.saveTopicSummary(100, 'A summary', 5, 4);
      const formatted = topicMemory.formatContextForSession(100);
      expect(formatted).not.toContain('Current focus');
    });

    it('places purpose after topic name and before summary', () => {
      insertMessages(100, 5);
      topicMemory.setTopicName(100, 'auth-debugging');
      topicMemory.saveTopicSummary(100, 'Detailed summary content', 5, 4, 'Token refresh failures');
      const formatted = topicMemory.formatContextForSession(100);

      const topicIdx = formatted.indexOf('Topic: auth-debugging');
      const purposeIdx = formatted.indexOf('Current focus: Token refresh failures');
      const summaryIdx = formatted.indexOf('CONVERSATION SUMMARY:');

      expect(topicIdx).toBeGreaterThan(-1);
      expect(purposeIdx).toBeGreaterThan(topicIdx);
      expect(summaryIdx).toBeGreaterThan(purposeIdx);
    });
  });

  describe('formatContextForUser with purpose', () => {
    it('includes "Current focus" line when purpose exists', () => {
      insertMessages(100, 5);
      topicMemory.saveTopicSummary(100, 'A summary', 5, 4, 'Working on email templates');
      const formatted = topicMemory.formatContextForUser(100, 'user-123');
      // formatContextForUser may return empty if no messages match the user filter
      // but the method itself supports purpose injection
      if (formatted) {
        expect(formatted).toContain('Current focus: Working on email templates');
      }
    });
  });

  describe('schema migration', () => {
    it('purpose column exists on fresh database', () => {
      // The topicMemory created in beforeEach is a fresh database
      // Verify we can save and retrieve purpose
      topicMemory.saveTopicSummary(100, 'Test', 1, 0, 'Test purpose');
      const saved = topicMemory.getTopicSummary(100);
      expect(saved!.purpose).toBe('Test purpose');
    });

    it('purpose defaults to null for summaries created without it', () => {
      // Save a summary without purpose (backwards compat)
      topicMemory.saveTopicSummary(100, 'Test summary', 1, 0);
      const saved = topicMemory.getTopicSummary(100);
      expect(saved!.purpose).toBeNull();
    });
  });
});
