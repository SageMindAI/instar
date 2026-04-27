/**
 * Unit tests for CommitmentSentinel — LLM-powered commitment scanner.
 *
 * Tests cover:
 * - JSONL message reading
 * - High-water mark tracking
 * - Conversation pair extraction
 * - LLM commitment detection (mocked IntelligenceProvider)
 * - Duplicate detection (sentinel → tracker integration)
 * - Scan state persistence
 * - Edge cases: malformed messages, empty topics, LLM failures
 * - Lifecycle (start/stop)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentSentinel } from '../../src/monitoring/CommitmentSentinel.js';
import type { CommitmentSentinelConfig } from '../../src/monitoring/CommitmentSentinel.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

// ── Mock IntelligenceProvider ────────────────────────────────────

function createMockIntelligence(responses: Record<string, string> | string = '[]'): IntelligenceProvider {
  const defaultResponse = typeof responses === 'string' ? responses : '[]';
  return {
    evaluate: vi.fn(async (prompt: string, _options?: IntelligenceOptions) => {
      if (typeof responses === 'string') return responses;
      // Check if any key matches a substring of the prompt
      for (const [key, value] of Object.entries(responses)) {
        if (prompt.includes(key)) return value;
      }
      return defaultResponse;
    }),
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function createTmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ updates: { autoApply: true } }, null, 2)
  );
  return {
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }),
  };
}

function writeMessages(stateDir: string, messages: Array<{
  messageId: number;
  topicId: number;
  text: string;
  fromUser: boolean;
  timestamp?: string;
}>): void {
  const messagesPath = path.join(stateDir, 'telegram-messages.jsonl');
  const lines = messages.map(m => JSON.stringify({
    messageId: m.messageId,
    topicId: m.topicId,
    text: m.text,
    fromUser: m.fromUser,
    timestamp: m.timestamp ?? new Date().toISOString(),
  }));
  fs.writeFileSync(messagesPath, lines.join('\n') + '\n');
}

function makeSentinel(
  stateDir: string,
  intelligence: IntelligenceProvider,
  trackerOverrides?: Partial<import('../../src/monitoring/CommitmentTracker.js').CommitmentTrackerConfig>,
): { sentinel: CommitmentSentinel; tracker: CommitmentTracker } {
  const liveConfig = new LiveConfig(stateDir);
  const tracker = new CommitmentTracker({ stateDir, liveConfig, ...trackerOverrides });
  const sentinel = new CommitmentSentinel({
    stateDir,
    intelligence,
    commitmentTracker: tracker,
  });
  return { sentinel, tracker };
}

// ── Tests ────────────────────────────────────────────────────────

describe('CommitmentSentinel', () => {
  let stateDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ stateDir, cleanup } = createTmpState());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── Message Reading ────────────────────────────────────

  describe('message reading', () => {
    it('reads messages from JSONL file', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Turn off auto-updates', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Got it, turning off auto-updates now', fromUser: false },
      ]);

      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      await sentinel.scan();

      // Intelligence should have been called with the conversation
      expect(intelligence.evaluate).toHaveBeenCalled();
    });

    it('returns 0 when no message file exists', async () => {
      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(0);
      expect(intelligence.evaluate).not.toHaveBeenCalled();
    });

    it('returns 0 for empty message file', async () => {
      fs.writeFileSync(path.join(stateDir, 'telegram-messages.jsonl'), '');
      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(0);
    });

    it('skips malformed JSON lines', async () => {
      const messagesPath = path.join(stateDir, 'telegram-messages.jsonl');
      fs.writeFileSync(messagesPath, [
        '{"messageId":1,"topicId":100,"text":"hello","fromUser":true}',
        'this is not valid json',
        '{"messageId":2,"topicId":100,"text":"hi there","fromUser":false}',
      ].join('\n') + '\n');

      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      // Should not throw
      const detected = await sentinel.scan();
      expect(detected).toBe(0); // No commitments detected (mock returns [])
    });

    it('skips messages missing required fields', async () => {
      const messagesPath = path.join(stateDir, 'telegram-messages.jsonl');
      fs.writeFileSync(messagesPath, [
        '{"messageId":1,"topicId":100}', // missing text
        '{"messageId":2,"text":"hi"}', // missing topicId
        '{"topicId":100,"text":"hello"}', // missing messageId
      ].join('\n') + '\n');

      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(0);
      expect(intelligence.evaluate).not.toHaveBeenCalled();
    });
  });

  // ── High-Water Mark ────────────────────────────────────

  describe('high-water mark tracking', () => {
    it('only reads messages newer than high-water mark', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Old request', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Old response', fromUser: false },
        { messageId: 3, topicId: 100, text: 'New request', fromUser: true },
        { messageId: 4, topicId: 100, text: 'New response', fromUser: false },
      ]);

      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      // First scan reads all
      await sentinel.scan();
      expect(intelligence.evaluate).toHaveBeenCalledTimes(1);
      const firstCallPrompt = (intelligence.evaluate as any).mock.calls[0][0] as string;
      expect(firstCallPrompt).toContain('Old request');
      expect(firstCallPrompt).toContain('New request');

      // Second scan should find no new messages
      (intelligence.evaluate as any).mockClear();
      await sentinel.scan();
      expect(intelligence.evaluate).not.toHaveBeenCalled();
    });

    it('persists high-water mark to disk', async () => {
      writeMessages(stateDir, [
        { messageId: 10, topicId: 100, text: 'Request', fromUser: true },
        { messageId: 11, topicId: 100, text: 'Response', fromUser: false },
      ]);

      const intelligence = createMockIntelligence('[]');
      const { sentinel: sentinel1 } = makeSentinel(stateDir, intelligence);

      await sentinel1.scan();

      // Check scan state file exists
      const scanStatePath = path.join(stateDir, 'state', 'commitment-sentinel.json');
      expect(fs.existsSync(scanStatePath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(scanStatePath, 'utf-8'));
      expect(state.topicHighWaterMark[100]).toBe(11);
      expect(state.lastScanAt).toBeTruthy();

      // New sentinel instance should pick up where we left off
      const intelligence2 = createMockIntelligence('[]');
      const { sentinel: sentinel2 } = makeSentinel(stateDir, intelligence2);

      // No new messages → should not call intelligence
      await sentinel2.scan();
      expect(intelligence2.evaluate).not.toHaveBeenCalled();
    });

    it('tracks per-topic high-water marks', async () => {
      writeMessages(stateDir, [
        { messageId: 10, topicId: 100, text: 'Request in topic 100', fromUser: true },
        { messageId: 11, topicId: 100, text: 'Response in topic 100', fromUser: false },
        { messageId: 20, topicId: 200, text: 'Request in topic 200', fromUser: true },
        { messageId: 21, topicId: 200, text: 'Response in topic 200', fromUser: false },
      ]);

      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      await sentinel.scan();

      const scanStatePath = path.join(stateDir, 'state', 'commitment-sentinel.json');
      const state = JSON.parse(fs.readFileSync(scanStatePath, 'utf-8'));
      expect(state.topicHighWaterMark[100]).toBe(11);
      expect(state.topicHighWaterMark[200]).toBe(21);
    });
  });

  // ── Conversation Pair Extraction ───────────────────────

  describe('conversation pair extraction', () => {
    it('extracts user→agent pairs', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Turn off auto-updates', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Got it, turning off auto-updates now', fromUser: false },
      ]);

      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      await sentinel.scan();

      const prompt = (intelligence.evaluate as any).mock.calls[0][0] as string;
      expect(prompt).toContain('Turn off auto-updates');
      expect(prompt).toContain('Got it, turning off auto-updates now');
    });

    it('skips agent→user pairs (not a commitment pattern)', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Agent says something first', fromUser: false },
        { messageId: 2, topicId: 100, text: 'User responds', fromUser: true },
      ]);

      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      await sentinel.scan();

      // No valid user→agent pair, so no LLM call
      expect(intelligence.evaluate).not.toHaveBeenCalled();
    });

    it('handles multiple pairs in one topic', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'First request', fromUser: true },
        { messageId: 2, topicId: 100, text: 'First response', fromUser: false },
        { messageId: 3, topicId: 100, text: 'Second request', fromUser: true },
        { messageId: 4, topicId: 100, text: 'Second response', fromUser: false },
      ]);

      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      await sentinel.scan();

      const prompt = (intelligence.evaluate as any).mock.calls[0][0] as string;
      expect(prompt).toContain('Exchange 1');
      expect(prompt).toContain('Exchange 2');
    });
  });

  // ── LLM Commitment Detection ──────────────────────────

  describe('LLM commitment detection', () => {
    it('detects and registers a config-change commitment', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Turn off auto-updates', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Got it, turning off auto-updates now', fromUser: false },
      ]);

      const llmResponse = JSON.stringify([{
        type: 'config-change',
        userRequest: 'Turn off auto-updates',
        agentResponse: 'Got it, turning off auto-updates now',
        configPath: 'updates.autoApply',
        configExpectedValue: false,
      }]);

      const intelligence = createMockIntelligence(llmResponse);
      const { sentinel, tracker } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(1);

      const commitments = tracker.getAll();
      expect(commitments).toHaveLength(1);
      expect(commitments[0].source).toBe('sentinel');
      expect(commitments[0].type).toBe('config-change');
      expect(commitments[0].userRequest).toBe('Turn off auto-updates');
      expect(commitments[0].topicId).toBe(100);
    });

    it('detects behavioral commitments', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Always check with me before deploying', fromUser: true },
        { messageId: 2, topicId: 100, text: "Understood, I'll always check with you before deploying", fromUser: false },
      ]);

      const llmResponse = JSON.stringify([{
        type: 'behavioral',
        userRequest: 'Always check with me before deploying',
        agentResponse: "Understood, I'll always check with you before deploying",
        behavioralRule: 'Always check with the user before deploying any changes',
      }]);

      const intelligence = createMockIntelligence(llmResponse);
      const { sentinel, tracker } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(1);
      expect(tracker.getAll()[0].type).toBe('behavioral');
      expect(tracker.getAll()[0].behavioralRule).toContain('check with the user');
    });

    it('handles LLM returning markdown-wrapped JSON', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Stop daily reports', fromUser: true },
        { messageId: 2, topicId: 100, text: "OK, I'll stop the daily reports", fromUser: false },
      ]);

      const llmResponse = '```json\n[{"type":"behavioral","userRequest":"Stop daily reports","agentResponse":"OK, I\'ll stop","behavioralRule":"Do not send daily reports"}]\n```';

      const intelligence = createMockIntelligence(llmResponse);
      const { sentinel, tracker } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(1);
      expect(tracker.getAll()[0].behavioralRule).toContain('daily reports');
    });

    it('handles LLM returning empty array (no commitments)', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'What time is it?', fromUser: true },
        { messageId: 2, topicId: 100, text: "It's 3:00 PM", fromUser: false },
      ]);

      const intelligence = createMockIntelligence('[]');
      const { sentinel, tracker } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(0);
      expect(tracker.getAll()).toHaveLength(0);
    });

    it('filters out invalid commitment types from LLM response', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Do something', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Done', fromUser: false },
      ]);

      const llmResponse = JSON.stringify([
        { type: 'behavioral', userRequest: 'valid', agentResponse: 'yes', behavioralRule: 'rule' },
        { type: 'unknown-type', userRequest: 'invalid', agentResponse: 'yes' },
        { type: 'config-change' }, // missing required fields
      ]);

      const intelligence = createMockIntelligence(llmResponse);
      const { sentinel, tracker } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(1); // only the valid behavioral one
      expect(tracker.getAll()).toHaveLength(1);
    });
  });

  // ── Duplicate Detection ────────────────────────────────

  describe('duplicate detection', () => {
    it('does not re-register a commitment already in tracker', async () => {
      const liveConfig = new LiveConfig(stateDir);
      const tracker = new CommitmentTracker({ stateDir, liveConfig });

      // Pre-register a commitment
      tracker.record({
        type: 'config-change',
        userRequest: 'Turn off auto-updates',
        agentResponse: 'Done',
        topicId: 100,
        configPath: 'updates.autoApply',
        configExpectedValue: false,
      });

      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Turn off auto-updates', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Got it, turning off auto-updates now', fromUser: false },
      ]);

      const llmResponse = JSON.stringify([{
        type: 'config-change',
        userRequest: 'Turn off auto-updates',
        agentResponse: 'Got it, turning off auto-updates now',
        configPath: 'updates.autoApply',
        configExpectedValue: false,
      }]);

      const intelligence = createMockIntelligence(llmResponse);
      const sentinel = new CommitmentSentinel({
        stateDir,
        intelligence,
        commitmentTracker: tracker,
      });

      const detected = await sentinel.scan();
      expect(detected).toBe(0); // duplicate, should not register
      expect(tracker.getAll()).toHaveLength(1); // still just the original
    });
  });

  // ── LLM Failure Handling ───────────────────────────────

  describe('LLM failure handling', () => {
    it('handles LLM returning invalid JSON gracefully', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Do something', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Done', fromUser: false },
      ]);

      const intelligence = createMockIntelligence('this is not json at all');
      const { sentinel, tracker } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(0);
      expect(tracker.getAll()).toHaveLength(0);
    });

    it('handles LLM throwing an error gracefully', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Do something', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Done', fromUser: false },
      ]);

      const intelligence: IntelligenceProvider = {
        evaluate: vi.fn(async () => { throw new Error('API quota exceeded'); }),
      };
      const { sentinel, tracker } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(0);
      expect(tracker.getAll()).toHaveLength(0);
    });

    it('handles LLM returning non-array JSON', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Do something', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Done', fromUser: false },
      ]);

      const intelligence = createMockIntelligence('{"error": "something went wrong"}');
      const { sentinel, tracker } = makeSentinel(stateDir, intelligence);

      const detected = await sentinel.scan();
      expect(detected).toBe(0);
    });
  });

  // ── Multi-topic Scanning ───────────────────────────────

  describe('multi-topic scanning', () => {
    it('scans multiple topics independently', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Turn off updates', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Done', fromUser: false },
        { messageId: 10, topicId: 200, text: 'Always check first', fromUser: true },
        { messageId: 11, topicId: 200, text: 'Will do', fromUser: false },
      ]);

      // Return different commitments for different topics
      const intelligence: IntelligenceProvider = {
        evaluate: vi.fn(async (prompt: string) => {
          if (prompt.includes('Turn off updates')) {
            return JSON.stringify([{
              type: 'config-change',
              userRequest: 'Turn off updates',
              agentResponse: 'Done',
              configPath: 'updates.autoApply',
              configExpectedValue: false,
            }]);
          }
          if (prompt.includes('Always check first')) {
            return JSON.stringify([{
              type: 'behavioral',
              userRequest: 'Always check first',
              agentResponse: 'Will do',
              behavioralRule: 'Check with user before changes',
            }]);
          }
          return '[]';
        }),
      };

      const { sentinel, tracker } = makeSentinel(stateDir, intelligence);
      const detected = await sentinel.scan();
      expect(detected).toBe(2);
      expect(tracker.getAll()).toHaveLength(2);

      // Verify topic IDs are correct
      const commitments = tracker.getAll();
      const byTopic = new Map<number, typeof commitments>();
      for (const c of commitments) {
        const list = byTopic.get(c.topicId!) ?? [];
        list.push(c);
        byTopic.set(c.topicId!, list);
      }
      expect(byTopic.get(100)![0].type).toBe('config-change');
      expect(byTopic.get(200)![0].type).toBe('behavioral');
    });
  });

  // ── Concurrent Scan Protection ─────────────────────────

  describe('concurrency protection', () => {
    it('prevents concurrent scans', async () => {
      writeMessages(stateDir, [
        { messageId: 1, topicId: 100, text: 'Request', fromUser: true },
        { messageId: 2, topicId: 100, text: 'Response', fromUser: false },
      ]);

      let resolveEvaluate: (() => void) | undefined;
      const intelligence: IntelligenceProvider = {
        evaluate: vi.fn(() => new Promise<string>((resolve) => {
          resolveEvaluate = () => resolve('[]');
        })),
      };

      const { sentinel } = makeSentinel(stateDir, intelligence);

      // Start first scan (will block on evaluate)
      const scan1 = sentinel.scan();

      // Start second scan while first is running
      const scan2Promise = sentinel.scan();

      // Second scan should return 0 immediately (isScanning guard)
      const scan2Result = await scan2Promise;
      expect(scan2Result).toBe(0);

      // Resolve the first scan
      resolveEvaluate!();
      await scan1;
    });
  });

  // ── Lifecycle ──────────────────────────────────────────

  describe('start() / stop()', () => {
    it('starts and stops without error', () => {
      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      sentinel.start();
      sentinel.stop();
    });

    it('start() is idempotent', () => {
      const intelligence = createMockIntelligence('[]');
      const { sentinel } = makeSentinel(stateDir, intelligence);

      sentinel.start();
      sentinel.start(); // should not create duplicate intervals
      sentinel.stop();
    });
  });
});
