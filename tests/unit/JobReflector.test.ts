/**
 * Unit tests for JobReflector — LLM-powered per-job reflection.
 *
 * Tests cover:
 * - Graceful null when no IntelligenceProvider configured
 * - Prompt construction with steps, deviations, historical context
 * - JSON response parsing (clean, wrapped in code blocks, malformed)
 * - Integration with ExecutionJournal data
 * - Specific session targeting
 * - Telegram formatting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobReflector } from '../../src/core/JobReflector.js';
import type { IntelligenceProvider, ExecutionRecord } from '../../src/core/types.js';

function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: `exec-${Math.random().toString(36).slice(2, 8)}`,
    jobSlug: 'test-job',
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'default',
    timestamp: new Date().toISOString(),
    definedSteps: [],
    actualSteps: [],
    deviations: [],
    outcome: 'success',
    finalized: true,
    ...overrides,
  };
}

// Generate timestamps relative to now to stay within the 30-day analysis window.
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function writeRecords(stateDir: string, jobSlug: string, records: ExecutionRecord[], agentId = 'default'): void {
  const dir = path.join(stateDir, 'state', 'execution-journal', agentId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobSlug}.jsonl`);
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, content);
}

function makeMockProvider(response: string): IntelligenceProvider {
  return {
    evaluate: vi.fn().mockResolvedValue(response),
  };
}

const GOOD_RESPONSE = JSON.stringify({
  summary: 'The health check completed successfully with all expected steps.',
  strengths: ['Completed within expected duration', 'All endpoints responded'],
  improvements: ['Could add timeout handling for slow endpoints'],
  deviationAnalysis: null,
  purposeDrift: null,
  retroactiveCorrections: [],
  suggestedChanges: ['Add a timeout parameter to the curl commands'],
});

describe('JobReflector', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-reflector-'));
    stateDir = tmpDir;
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── No Provider ──────────────────────────────────────────────────

  describe('no intelligence provider', () => {
    it('returns null when no provider configured', async () => {
      const reflector = new JobReflector({ stateDir });
      writeRecords(stateDir, 'my-job', [makeRecord({ jobSlug: 'my-job' })]);

      const result = await reflector.reflect('my-job');
      expect(result).toBeNull();
    });

    it('reflectAll returns empty array without provider', async () => {
      const reflector = new JobReflector({ stateDir });
      writeRecords(stateDir, 'my-job', [makeRecord({ jobSlug: 'my-job' })]);

      const results = await reflector.reflectAll();
      expect(results).toEqual([]);
    });
  });

  // ─── No Data ──────────────────────────────────────────────────────

  describe('no execution data', () => {
    it('returns null when no journal entries exist', async () => {
      const provider = makeMockProvider(GOOD_RESPONSE);
      const reflector = new JobReflector({ stateDir, intelligence: provider });

      const result = await reflector.reflect('nonexistent-job');
      expect(result).toBeNull();
      expect(provider.evaluate).not.toHaveBeenCalled();
    });
  });

  // ─── LLM Call ─────────────────────────────────────────────────────

  describe('LLM reflection', () => {
    it('calls intelligence provider with constructed prompt', async () => {
      const provider = makeMockProvider(GOOD_RESPONSE);
      const reflector = new JobReflector({ stateDir, intelligence: provider });

      writeRecords(stateDir, 'health-check', [
        makeRecord({
          jobSlug: 'health-check',
          sessionId: 'sess-001',
          definedSteps: ['check-api', 'check-db'],
          actualSteps: [
            { step: 'check-api', timestamp: daysAgo(1), source: 'hook', command: 'curl http://localhost/health' },
            { step: 'check-db', timestamp: daysAgo(1), source: 'hook', command: 'psql -c "SELECT 1"' },
          ],
          outcome: 'success',
          durationMinutes: 5,
          timestamp: daysAgo(1),
        }),
      ]);

      const result = await reflector.reflect('health-check');

      expect(result).not.toBeNull();
      expect(provider.evaluate).toHaveBeenCalledOnce();

      // Verify prompt includes key information
      const prompt = (provider.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).toContain('health-check');
      expect(prompt).toContain('check-api');
      expect(prompt).toContain('check-db');
      expect(prompt).toContain('curl');
    });

    it('uses capable model by default', async () => {
      const provider = makeMockProvider(GOOD_RESPONSE);
      const reflector = new JobReflector({ stateDir, intelligence: provider });
      writeRecords(stateDir, 'test-job', [makeRecord()]);

      await reflector.reflect('test-job');

      const opts = (provider.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(opts.model).toBe('capable');
    });

    it('uses configured model tier', async () => {
      const provider = makeMockProvider(GOOD_RESPONSE);
      const reflector = new JobReflector({ stateDir, intelligence: provider, model: 'balanced' });
      writeRecords(stateDir, 'test-job', [makeRecord()]);

      await reflector.reflect('test-job');

      const opts = (provider.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(opts.model).toBe('balanced');
    });
  });

  // ─── Response Parsing ─────────────────────────────────────────────

  describe('response parsing', () => {
    it('parses clean JSON response', () => {
      const reflector = new JobReflector({ stateDir });
      const insight = reflector.parseResponse(GOOD_RESPONSE, 'my-job', 'sess-001');

      expect(insight.jobSlug).toBe('my-job');
      expect(insight.sessionId).toBe('sess-001');
      expect(insight.summary).toContain('health check completed');
      expect(insight.strengths).toHaveLength(2);
      expect(insight.improvements).toHaveLength(1);
      expect(insight.deviationAnalysis).toBeNull();
      expect(insight.suggestedChanges).toHaveLength(1);
    });

    it('parses JSON wrapped in markdown code blocks', () => {
      const wrapped = '```json\n' + GOOD_RESPONSE + '\n```';
      const reflector = new JobReflector({ stateDir });
      const insight = reflector.parseResponse(wrapped, 'my-job', 'sess-001');

      expect(insight.summary).toContain('health check completed');
      expect(insight.strengths).toHaveLength(2);
    });

    it('handles malformed JSON gracefully', () => {
      const reflector = new JobReflector({ stateDir });
      const insight = reflector.parseResponse('this is not json at all', 'my-job', 'sess-001');

      expect(insight.jobSlug).toBe('my-job');
      expect(insight.summary).toContain('Unable to parse');
      expect(insight.strengths).toEqual([]);
      expect(insight.rawResponse).toBe('this is not json at all');
    });

    it('handles partial JSON (missing fields)', () => {
      const partial = JSON.stringify({ summary: 'Partial response', strengths: ['One thing'] });
      const reflector = new JobReflector({ stateDir });
      const insight = reflector.parseResponse(partial, 'my-job', 'sess-001');

      expect(insight.summary).toBe('Partial response');
      expect(insight.strengths).toEqual(['One thing']);
      expect(insight.improvements).toEqual([]);
      expect(insight.deviationAnalysis).toBeNull();
    });

    it('filters non-string array items', () => {
      const bad = JSON.stringify({
        summary: 'Test',
        strengths: ['valid', 123, null, 'also valid'],
        improvements: [],
      });
      const reflector = new JobReflector({ stateDir });
      const insight = reflector.parseResponse(bad, 'my-job', 'sess-001');

      expect(insight.strengths).toEqual(['valid', 'also valid']);
    });
  });

  // ─── Session Targeting ────────────────────────────────────────────

  describe('session targeting', () => {
    it('reflects on specific session when sessionId provided', async () => {
      const provider = makeMockProvider(GOOD_RESPONSE);
      const reflector = new JobReflector({ stateDir, intelligence: provider });

      writeRecords(stateDir, 'targeted', [
        makeRecord({
          jobSlug: 'targeted',
          sessionId: 'sess-newer',
          outcome: 'failure',
          timestamp: daysAgo(1),
        }),
        makeRecord({
          jobSlug: 'targeted',
          sessionId: 'sess-older',
          outcome: 'success',
          timestamp: daysAgo(2),
        }),
      ]);

      await reflector.reflect('targeted', { sessionId: 'sess-older' });

      const prompt = (provider.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).toContain('sess-older');
      expect(prompt).toContain('success');
    });

    it('returns null for nonexistent session', async () => {
      const provider = makeMockProvider(GOOD_RESPONSE);
      const reflector = new JobReflector({ stateDir, intelligence: provider });
      writeRecords(stateDir, 'job', [makeRecord({ jobSlug: 'job' })]);

      const result = await reflector.reflect('job', { sessionId: 'nonexistent' });
      expect(result).toBeNull();
    });
  });

  // ─── Provider Error ───────────────────────────────────────────────

  describe('provider error handling', () => {
    it('returns null when provider throws', async () => {
      const provider: IntelligenceProvider = {
        evaluate: vi.fn().mockRejectedValue(new Error('API rate limited')),
      };
      const reflector = new JobReflector({ stateDir, intelligence: provider });
      writeRecords(stateDir, 'error-job', [makeRecord({ jobSlug: 'error-job' })]);

      const result = await reflector.reflect('error-job');
      expect(result).toBeNull();
    });
  });

  // ─── Prompt Content ───────────────────────────────────────────────

  describe('prompt construction', () => {
    it('includes deviations in prompt', async () => {
      const provider = makeMockProvider(GOOD_RESPONSE);
      const reflector = new JobReflector({ stateDir, intelligence: provider });

      writeRecords(stateDir, 'dev-job', [
        makeRecord({
          jobSlug: 'dev-job',
          definedSteps: ['step-a'],
          actualSteps: [
            { step: 'step-b', timestamp: daysAgo(1), source: 'hook' },
          ],
          deviations: [
            { type: 'addition', step: 'step-b' },
            { type: 'omission', step: 'step-a' },
          ],
        }),
      ]);

      await reflector.reflect('dev-job');

      const prompt = (provider.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).toContain('addition: step-b');
      expect(prompt).toContain('omission: step-a');
    });

    it('includes historical context when multiple runs exist', async () => {
      const provider = makeMockProvider(GOOD_RESPONSE);
      const reflector = new JobReflector({ stateDir, intelligence: provider });

      writeRecords(stateDir, 'history-job', Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'history-job',
        outcome: i < 3 ? 'success' : 'failure',
        durationMinutes: 10 + i,
        timestamp: daysAgo(5 - i),
      })));

      await reflector.reflect('history-job');

      const prompt = (provider.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).toContain('Historical Context');
      expect(prompt).toContain('5 recent runs');
      expect(prompt).toContain('Success rate');
    });
  });

  // ─── Telegram Formatting ──────────────────────────────────────────

  describe('formatInsight', () => {
    it('formats a complete insight', () => {
      const reflector = new JobReflector({ stateDir });
      const insight = reflector.parseResponse(GOOD_RESPONSE, 'health-check', 'sess-001');
      const formatted = reflector.formatInsight(insight);

      expect(formatted).toContain('Reflection: health-check');
      expect(formatted).toContain('Strengths:');
      expect(formatted).toContain('Improvements:');
      expect(formatted).toContain('Suggested changes:');
    });

    it('omits empty sections', () => {
      const reflector = new JobReflector({ stateDir });
      const minimal = JSON.stringify({
        summary: 'Clean execution.',
        strengths: [],
        improvements: [],
        deviationAnalysis: null,
        purposeDrift: null,
        retroactiveCorrections: [],
        suggestedChanges: [],
      });
      const insight = reflector.parseResponse(minimal, 'clean-job', 'sess-001');
      const formatted = reflector.formatInsight(insight);

      expect(formatted).toContain('Clean execution.');
      expect(formatted).not.toContain('Strengths:');
      expect(formatted).not.toContain('Improvements:');
      expect(formatted).not.toContain('Suggested changes:');
    });
  });

  // ─── reflectAll ───────────────────────────────────────────────────

  describe('reflectAll', () => {
    it('reflects on all jobs with data', async () => {
      const provider = makeMockProvider(GOOD_RESPONSE);
      const reflector = new JobReflector({ stateDir, intelligence: provider });

      writeRecords(stateDir, 'job-x', [makeRecord({ jobSlug: 'job-x' })]);
      writeRecords(stateDir, 'job-y', [makeRecord({ jobSlug: 'job-y' })]);

      const insights = await reflector.reflectAll();

      expect(insights).toHaveLength(2);
      expect(provider.evaluate).toHaveBeenCalledTimes(2);
    });
  });
});
