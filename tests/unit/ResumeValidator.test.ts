/**
 * ResumeValidator — LLM-supervised coherence gate for session resume.
 *
 * Tests the coherence check that validates a session's content matches
 * a topic's conversation history before resuming.
 *
 * CRITICAL REQUIREMENT: Instar NEVER requires external API keys for
 * functionality that can be handled by Claude Code models. The ResumeValidator
 * uses IntelligenceProvider (Claude CLI) — no GOOGLE_GENERATIVE_AI_API_KEY,
 * no ANTHROPIC_API_KEY, no external dependencies.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { llmValidateResumeCoherence } from '../../src/core/ResumeValidator.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────

const INTERACTIVE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TOPIC_ID = 9154;

const topicHistory = async () => ({
  topicName: 'test-topic',
  messages: [
    { sender: 'User', text: 'Can you help debug the login issue?' },
    { sender: 'Agent', text: 'Looking into the authentication flow now.' },
  ],
});

const matchingSession = () =>
  'Session content samples:\n  Debugging authentication flow. Found issue in login handler.';

const mismatchingSession = () =>
  'Session content samples:\n  Posted 5 messages on AICQ about consciousness topics.';

// ─── No External API Keys Required ─────────────────────────────────────

describe('ResumeValidator: No External API Keys Required', () => {
  it('does NOT import or reference GOOGLE_GENERATIVE_AI_API_KEY', () => {
    const source = fs.readFileSync(
      new URL('../../src/core/ResumeValidator.ts', import.meta.url),
      'utf-8',
    );
    expect(source).not.toContain('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('does NOT import or reference ANTHROPIC_API_KEY', () => {
    const source = fs.readFileSync(
      new URL('../../src/core/ResumeValidator.ts', import.meta.url),
      'utf-8',
    );
    expect(source).not.toContain('ANTHROPIC_API_KEY');
  });

  it('does NOT make direct HTTP calls to external AI APIs', () => {
    const source = fs.readFileSync(
      new URL('../../src/core/ResumeValidator.ts', import.meta.url),
      'utf-8',
    );
    expect(source).not.toContain('generativelanguage.googleapis.com');
    expect(source).not.toContain('api.anthropic.com');
    expect(source).not.toContain('openai.com');
  });

  it('uses IntelligenceProvider interface (Claude CLI compatible)', () => {
    const source = fs.readFileSync(
      new URL('../../src/core/ResumeValidator.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toContain('IntelligenceProvider');
    expect(source).toContain("import type { IntelligenceProvider }");
  });

  it('fails safe when no IntelligenceProvider is available', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project',
      null, // no telegram
      null, // no intelligence provider
      // no evaluateFn either
    );
    expect(result).toBe(false);
  });
});

// ─── LLM Coherence Gate Tests ───────────────────────────────────────────

describe('ResumeValidator: LLM Coherence Gate', () => {
  it('returns true when LLM says MATCH', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'MATCH',
      },
    );
    expect(result).toBe(true);
  });

  it('returns false when LLM says MISMATCH', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: mismatchingSession,
        evaluateFn: async () => 'MISMATCH',
      },
    );
    expect(result).toBe(false);
  });

  it('fails safe on LLM error', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => { throw new Error('Claude CLI timeout'); },
      },
    );
    expect(result).toBe(false);
  });

  it('fails safe on empty LLM response', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => '',
      },
    );
    expect(result).toBe(false);
  });

  it('fails safe on ambiguous response (neither MATCH nor MISMATCH)', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'UNCLEAR - need more context',
      },
    );
    expect(result).toBe(false);
  });

  it('fails safe when response contains both MATCH and MISMATCH', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'It could be a MATCH or a MISMATCH',
      },
    );
    expect(result).toBe(false);
  });

  it('handles case-insensitive MATCH response', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'match',
      },
    );
    expect(result).toBe(true);
  });

  it('handles MATCH with trailing whitespace/newlines', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'MATCH\n',
      },
    );
    expect(result).toBe(true);
  });

  it('passes correct prompt to evaluator', async () => {
    let capturedPrompt = '';
    await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async (prompt: string) => { capturedPrompt = prompt; return 'MATCH'; },
      },
    );

    expect(capturedPrompt).toContain('test-topic');
    expect(capturedPrompt).toContain('MATCH or MISMATCH');
    expect(capturedPrompt).toContain('login issue');
    expect(capturedPrompt).toContain('authentication flow');
  });

  it('uses TelegramAdapter when deps.getTopicHistory not provided', async () => {
    let capturedPrompt = '';
    const mockTelegram = {
      searchLog: (opts: { topicId: number; limit: number }) => [
        { text: 'Hello from Telegram', fromUser: true },
        { text: 'Hello back', fromJustin: false, fromUser: false },
      ],
      getTopicName: () => 'telegram-topic',
    };

    await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', mockTelegram, null,
      {
        readSessionJsonl: matchingSession,
        evaluateFn: async (prompt: string) => { capturedPrompt = prompt; return 'MATCH'; },
      },
    );

    expect(capturedPrompt).toContain('Hello from Telegram');
    expect(capturedPrompt).toContain('User:');
  });

  it('handles topic history fetch failure gracefully', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: (async () => { throw new Error('JSONL read failed'); }) as any,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'MISMATCH',
      },
    );
    expect(result).toBe(false);
  });

  it('truncates very long content', async () => {
    let capturedPrompt = '';
    const longText = 'x'.repeat(5000);

    await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: async () => ({
          topicName: 'test-topic',
          messages: [{ sender: 'User', text: longText }],
        }),
        readSessionJsonl: () => longText,
        evaluateFn: async (prompt: string) => { capturedPrompt = prompt; return 'MATCH'; },
      },
    );

    expect(capturedPrompt.length).toBeLessThan(5000);
  });

  it('uses IntelligenceProvider.evaluate when evaluateFn not provided', async () => {
    let evaluateCalled = false;
    const mockIntelligence = {
      evaluate: async (prompt: string, options?: any) => {
        evaluateCalled = true;
        expect(options?.model).toBe('fast');
        return 'MATCH';
      },
    };

    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null,
      mockIntelligence,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
      },
    );

    expect(evaluateCalled).toBe(true);
    expect(result).toBe(true);
  });

  it('uses "fast" model tier for lightweight evaluation', async () => {
    let modelUsed = '';
    const mockIntelligence = {
      evaluate: async (_prompt: string, options?: any) => {
        modelUsed = options?.model ?? '';
        return 'MATCH';
      },
    };

    await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null,
      mockIntelligence,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
      },
    );

    expect(modelUsed).toBe('fast');
  });
});
