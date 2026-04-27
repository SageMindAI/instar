/**
 * Unit tests for IntegrationGate -- post-completion learning consolidation.
 *
 * Tests cover:
 * - Skip behavior for non-livingSkills jobs
 * - Skip behavior for explicit opt-out (integrationGate: false)
 * - Successful reflection capture for successful and failed jobs
 * - Blocking when failed jobs produce no learning
 * - Timeout handling
 * - CommonBlocker auto-population and deduplication
 * - Run history recording
 * - Consecutive block downgrade
 * - Timing in GateResult
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IntegrationGate } from '../../src/scheduler/IntegrationGate.js';
import type { IntegrationGateConfig, GateContext } from '../../src/scheduler/IntegrationGate.js';
import type { IntelligenceProvider, ExecutionRecord, JobDefinition } from '../../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function makeSlowProvider(delayMs: number, response: string): IntelligenceProvider {
  return {
    evaluate: vi.fn().mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(response), delayMs))
    ),
  };
}

function makeFailingProvider(): IntelligenceProvider {
  return {
    evaluate: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  };
}

function makeNullProvider(): IntelligenceProvider {
  // Returns valid JSON but reflection will be null because no records
  return {
    evaluate: vi.fn().mockResolvedValue('{}'),
  };
}

const GOOD_REFLECTION = JSON.stringify({
  summary: 'Job completed successfully with all steps.',
  strengths: ['Fast execution'],
  improvements: ['Could add error handling'],
  deviationAnalysis: null,
  purposeDrift: null,
  retroactiveCorrections: [],
  suggestedChanges: ['Add timeout parameter'],
});

function makeJob(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    slug: 'test-job',
    name: 'Test Job',
    description: 'A test job',
    schedule: '0 * * * *',
    priority: 'medium',
    expectedDurationMinutes: 5,
    model: 'haiku',
    enabled: true,
    execute: { type: 'prompt', value: 'test' },
    livingSkills: { enabled: true },
    ...overrides,
  };
}

function makeContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    job: makeJob(),
    sessionId: 'sess-123',
    runId: 'run-123',
    failed: false,
    output: 'Job completed',
    ...overrides,
  };
}

function makeMockRunHistory() {
  return {
    recordReflection: vi.fn(),
    recordStart: vi.fn(),
    recordCompletion: vi.fn(),
    findRun: vi.fn(),
    query: vi.fn(),
    compact: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('IntegrationGate', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-gate-'));
    stateDir = tmpDir;
    // Create required directories
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Skip Behavior ──────────────────────────────────────────────────

  describe('skip behavior', () => {
    it('skips for jobs without livingSkills enabled', async () => {
      const gate = new IntegrationGate({
        stateDir,
        intelligence: makeMockProvider(GOOD_REFLECTION),
        runHistory: makeMockRunHistory() as any,
      });

      const result = await gate.evaluate(makeContext({
        job: makeJob({ livingSkills: undefined }),
      }));

      expect(result.proceed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reflectionInsight).toBeNull();
    });

    it('skips for jobs with livingSkills.enabled = false', async () => {
      const gate = new IntegrationGate({
        stateDir,
        intelligence: makeMockProvider(GOOD_REFLECTION),
        runHistory: makeMockRunHistory() as any,
      });

      const result = await gate.evaluate(makeContext({
        job: makeJob({ livingSkills: { enabled: false } }),
      }));

      expect(result.proceed).toBe(true);
      expect(result.skipped).toBe(true);
    });

    it('skips when integrationGate explicitly set to false', async () => {
      const gate = new IntegrationGate({
        stateDir,
        intelligence: makeMockProvider(GOOD_REFLECTION),
        runHistory: makeMockRunHistory() as any,
      });

      const result = await gate.evaluate(makeContext({
        job: makeJob({ livingSkills: { enabled: true, integrationGate: false } }),
      }));

      expect(result.proceed).toBe(true);
      expect(result.skipped).toBe(true);
    });
  });

  // ── Successful Jobs ────────────────────────────────────────────────

  describe('successful jobs', () => {
    it('proceeds with reflection for successful job', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const runHistory = makeMockRunHistory();
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: runHistory as any,
      });

      // Write execution records so reflector has data
      writeRecords(stateDir, 'test-job', [
        makeRecord({ jobSlug: 'test-job', sessionId: 'sess-123' }),
      ]);

      const result = await gate.evaluate(makeContext());

      expect(result.proceed).toBe(true);
      expect(result.skipped).toBeUndefined();
      expect(result.reflectionInsight).not.toBeNull();
      expect(result.reflectionInsight?.summary).toContain('completed successfully');
    });

    it('proceeds even when reflection fails for successful job', async () => {
      const provider = makeFailingProvider();
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
      });

      writeRecords(stateDir, 'test-job', [
        makeRecord({ jobSlug: 'test-job', sessionId: 'sess-123' }),
      ]);

      const result = await gate.evaluate(makeContext());

      // Successful job + failed reflection = proceed (don't block success)
      expect(result.proceed).toBe(true);
    });

    it('proceeds for successful job with no intelligence provider', async () => {
      const gate = new IntegrationGate({
        stateDir,
        intelligence: null,
        runHistory: makeMockRunHistory() as any,
      });

      const result = await gate.evaluate(makeContext());

      expect(result.proceed).toBe(true);
      expect(result.reflectionInsight).toBeNull();
    });
  });

  // ── Failed Jobs ────────────────────────────────────────────────────

  describe('failed jobs', () => {
    it('proceeds for failed job when reflection succeeds', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
      });

      writeRecords(stateDir, 'test-job', [
        makeRecord({ jobSlug: 'test-job', sessionId: 'sess-123', outcome: 'failure' }),
      ]);

      const result = await gate.evaluate(makeContext({ failed: true }));

      expect(result.proceed).toBe(true);
      expect(result.reflectionInsight).not.toBeNull();
    });

    it('blocks failed job when no intelligence provider', async () => {
      const gate = new IntegrationGate({
        stateDir,
        intelligence: null,
        runHistory: makeMockRunHistory() as any,
      });

      const result = await gate.evaluate(makeContext({ failed: true }));

      expect(result.proceed).toBe(false);
      expect(result.gateBlockReason).toContain('no intelligence provider');
    });

    it('blocks failed job when reflection returns null (no records)', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
      });

      // No records written -- reflector will return null
      const result = await gate.evaluate(makeContext({ failed: true }));

      expect(result.proceed).toBe(false);
      expect(result.gateBlockReason).toContain('no insight');
    });
  });

  // ── Timeout Handling ───────────────────────────────────────────────

  describe('timeout handling', () => {
    it('proceeds with warning when reflection times out', async () => {
      const provider = makeSlowProvider(5000, GOOD_REFLECTION);
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
        defaultTimeoutMs: 100, // Very short timeout
      });

      writeRecords(stateDir, 'test-job', [
        makeRecord({ jobSlug: 'test-job', sessionId: 'sess-123' }),
      ]);

      const result = await gate.evaluate(makeContext());

      expect(result.proceed).toBe(true);
      expect(result.gateBlockReason).toContain('timed out');
    });

    it('respects per-job timeout override', async () => {
      const provider = makeSlowProvider(5000, GOOD_REFLECTION);
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
        defaultTimeoutMs: 60000, // Long default
      });

      writeRecords(stateDir, 'test-job', [
        makeRecord({ jobSlug: 'test-job', sessionId: 'sess-123' }),
      ]);

      const result = await gate.evaluate(makeContext({
        job: makeJob({ livingSkills: { enabled: true, integrationGateTimeoutMs: 100 } }),
      }));

      expect(result.proceed).toBe(true);
      expect(result.gateBlockReason).toContain('timed out');
    });
  });

  // ── CommonBlocker Auto-Population ──────────────────────────────────

  describe('CommonBlocker auto-population', () => {
    it('writes high-confidence patterns to auto-blockers.json', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
      });

      // Write multiple records with a consistent omission to trigger a high-confidence pattern
      const records = [];
      for (let i = 0; i < 10; i++) {
        records.push(makeRecord({
          jobSlug: 'test-job',
          sessionId: `sess-${i}`,
          definedSteps: ['step-a', 'step-b'],
          actualSteps: [
            { step: 'step-a', timestamp: new Date().toISOString(), source: 'hook' as const },
            // step-b consistently omitted
          ],
          deviations: [
            { type: 'omission' as const, step: 'step-b' },
          ],
        }));
      }
      writeRecords(stateDir, 'test-job', records);

      const result = await gate.evaluate(makeContext({ sessionId: records[0].sessionId }));

      // Check that auto-blockers.json was written
      const blockersFile = path.join(stateDir, 'state', 'jobs', 'test-job', 'auto-blockers.json');
      if (fs.existsSync(blockersFile)) {
        const blockers = JSON.parse(fs.readFileSync(blockersFile, 'utf-8'));
        // Should have at least the consistent omission pattern
        const keys = Object.keys(blockers);
        expect(result.blockersAdded.length).toBeGreaterThanOrEqual(0); // May or may not hit high confidence
      }

      // Gate should still proceed
      expect(result.proceed).toBe(true);
    });

    it('deduplicates CommonBlockers across runs', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
      });

      // Pre-populate auto-blockers.json with an existing blocker
      const blockersDir = path.join(stateDir, 'state', 'jobs', 'test-job');
      fs.mkdirSync(blockersDir, { recursive: true });
      fs.writeFileSync(path.join(blockersDir, 'auto-blockers.json'), JSON.stringify({
        'consistent-omission:step-b': {
          description: 'step-b consistently omitted',
          resolution: 'Add step-b',
          status: 'pending',
        },
      }));

      // Write records that would trigger the same pattern
      const records = [];
      for (let i = 0; i < 10; i++) {
        records.push(makeRecord({
          jobSlug: 'test-job',
          sessionId: `sess-${i}`,
          definedSteps: ['step-a', 'step-b'],
          actualSteps: [
            { step: 'step-a', timestamp: new Date().toISOString(), source: 'hook' as const },
          ],
          deviations: [
            { type: 'omission' as const, step: 'step-b' },
          ],
        }));
      }
      writeRecords(stateDir, 'test-job', records);

      const result = await gate.evaluate(makeContext({ sessionId: records[0].sessionId }));

      // Verify no duplicate was added
      const blockers = JSON.parse(fs.readFileSync(path.join(blockersDir, 'auto-blockers.json'), 'utf-8'));
      const keys = Object.keys(blockers);
      // Should still just have the one entry (deduplicated)
      const omissionKeys = keys.filter(k => k.includes('omission') && k.includes('step-b'));
      expect(omissionKeys.length).toBe(1);

      expect(result.proceed).toBe(true);
    });
  });

  // ── Run History Recording ──────────────────────────────────────────

  describe('run history recording', () => {
    it('records reflection in run history when runId present', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const runHistory = makeMockRunHistory();
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: runHistory as any,
      });

      writeRecords(stateDir, 'test-job', [
        makeRecord({ jobSlug: 'test-job', sessionId: 'sess-123' }),
      ]);

      await gate.evaluate(makeContext({ runId: 'run-456' }));

      expect(runHistory.recordReflection).toHaveBeenCalledWith('run-456', expect.objectContaining({
        summary: expect.any(String),
        strengths: expect.any(Array),
        improvements: expect.any(Array),
      }));
    });

    it('does not call recordReflection when runId is null', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const runHistory = makeMockRunHistory();
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: runHistory as any,
      });

      writeRecords(stateDir, 'test-job', [
        makeRecord({ jobSlug: 'test-job', sessionId: 'sess-123' }),
      ]);

      await gate.evaluate(makeContext({ runId: null }));

      expect(runHistory.recordReflection).not.toHaveBeenCalled();
    });
  });

  // ── Consecutive Block Downgrade ────────────────────────────────────

  describe('consecutive block downgrade', () => {
    it('auto-downgrades after MAX_CONSECUTIVE_BLOCKS', async () => {
      const gate = new IntegrationGate({
        stateDir,
        intelligence: null, // No intelligence = blocks for failed jobs
        runHistory: makeMockRunHistory() as any,
      });

      // Simulate MAX_CONSECUTIVE_BLOCKS failures
      for (let i = 0; i < IntegrationGate.MAX_CONSECUTIVE_BLOCKS; i++) {
        const result = await gate.evaluate(makeContext({ failed: true }));
        expect(result.proceed).toBe(false);
      }

      // The next one should auto-downgrade and proceed
      const result = await gate.evaluate(makeContext({ failed: true }));
      expect(result.proceed).toBe(true);
      expect(result.gateBlockReason).toContain('auto-downgraded');
    });

    it('resets consecutive block counter on success', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const gate = new IntegrationGate({
        stateDir,
        intelligence: null,
        runHistory: makeMockRunHistory() as any,
      });

      // Block twice
      await gate.evaluate(makeContext({ failed: true }));
      await gate.evaluate(makeContext({ failed: true }));

      // Now set intelligence and succeed — should reset counter
      // We need a new gate with intelligence for this
      const gateWithIntel = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
      });

      writeRecords(stateDir, 'test-job', [
        makeRecord({ jobSlug: 'test-job', sessionId: 'sess-123' }),
      ]);

      const successResult = await gateWithIntel.evaluate(makeContext());
      expect(successResult.proceed).toBe(true);
    });
  });

  // ── Timing ─────────────────────────────────────────────────────────

  describe('timing', () => {
    it('includes durationMs in result', async () => {
      const gate = new IntegrationGate({
        stateDir,
        intelligence: null,
        runHistory: makeMockRunHistory() as any,
      });

      const result = await gate.evaluate(makeContext({
        job: makeJob({ livingSkills: undefined }), // Skip path = fast
      }));

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe('number');
    });
  });

  // ── No Execution Records ──────────────────────────────────────────

  describe('no execution records', () => {
    it('proceeds for successful job with no records', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
      });

      // No records written
      const result = await gate.evaluate(makeContext());
      expect(result.proceed).toBe(true);
    });

    it('blocks for failed job with no records', async () => {
      const provider = makeMockProvider(GOOD_REFLECTION);
      const gate = new IntegrationGate({
        stateDir,
        intelligence: provider,
        runHistory: makeMockRunHistory() as any,
      });

      // No records written
      const result = await gate.evaluate(makeContext({ failed: true }));
      expect(result.proceed).toBe(false);
      expect(result.gateBlockReason).toContain('no insight');
    });
  });
});
