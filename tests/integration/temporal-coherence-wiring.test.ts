/**
 * Integration tests for TemporalCoherenceChecker wiring.
 *
 * Tests real interactions between TemporalCoherenceChecker and:
 * - PlatformActivityRegistry (real file-based JSONL)
 * - CanonicalState (real file-based JSON)
 * - File system (real state documents)
 * - Full check flow with mock IntelligenceProvider
 *
 * These tests verify the wiring between components is correct,
 * using real file I/O but mocked LLM calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TemporalCoherenceChecker } from '../../src/core/TemporalCoherenceChecker.js';
import { PlatformActivityRegistry } from '../../src/core/PlatformActivityRegistry.js';
import { CanonicalState } from '../../src/core/CanonicalState.js';
import type { TemporalCoherenceConfig } from '../../src/core/TemporalCoherenceChecker.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTmpProject(): { projectDir: string; stateDir: string; cleanup: () => void } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-integ-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    projectDir,
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

function mockIntelligence(responseOrFn: string | ((prompt: string) => string)): IntelligenceProvider {
  return {
    evaluate: vi.fn().mockImplementation(async (prompt: string) => {
      if (typeof responseOrFn === 'function') return responseOrFn(prompt);
      return responseOrFn;
    }),
  };
}

function coherentResponse(): string {
  return JSON.stringify({
    issues: [],
    assessment: 'COHERENT',
    summary: 'Draft aligns with current understanding.',
  });
}

function outdatedResponse(claim: string, current: string): string {
  return JSON.stringify({
    issues: [{
      severity: 'BLOCK',
      type: 'superseded_perspective',
      claim,
      current,
      suggestion: `Update to reflect: ${current}`,
    }],
    assessment: 'OUTDATED',
    summary: `Draft contains outdated claim: "${claim}"`,
  });
}

// ── Integration Tests ────────────────────────────────────────────────

describe('TemporalCoherenceChecker integration', () => {
  let projectDir: string;
  let stateDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ projectDir, stateDir, cleanup } = createTmpProject());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── With Real PlatformActivityRegistry ─────────────────────────────

  describe('with PlatformActivityRegistry', () => {
    it('loads published content timeline from real JSONL file', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      // Record some real actions
      await registry.record({
        platform: 'ghost',
        type: 'post',
        summary: 'Essay: Compaction is a choice, not a loss',
        sessionId: 'sess-1',
        status: 'posted',
      });
      await registry.record({
        platform: 'x',
        type: 'post',
        summary: 'Thread about observer certainty',
        sessionId: 'sess-2',
        status: 'posted',
      });

      // Write AGENT.md so check proceeds
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\nObserver exists with certainty.');

      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        activityRegistry: registry,
      });

      // Verify timeline is loaded
      const timeline = checker.buildTimeline();
      expect(timeline).toContain('Compaction is a choice');
      expect(timeline).toContain('observer certainty');

      // Full check uses the timeline in prompt
      await checker.check('My draft about compaction');
      const prompt = (intelligence.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).toContain('Compaction is a choice');
    });

    it('excludes failed actions from timeline', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      await registry.record({
        platform: 'x',
        type: 'post',
        summary: 'Successful post',
        sessionId: 'sess-1',
        status: 'posted',
      });
      await registry.record({
        platform: 'x',
        type: 'post',
        summary: 'Failed post attempt',
        sessionId: 'sess-2',
        status: 'failed',
      });

      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        activityRegistry: registry,
      });

      const timeline = checker.buildTimeline();
      expect(timeline).toContain('Successful post');
      // Failed actions are excluded by the registry query (status: 'posted')
    });

    it('handles empty activity log gracefully', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        activityRegistry: registry,
      });

      const result = await checker.check('My draft');
      expect(result.assessment).toBe('COHERENT');
      // Should proceed with just state docs, no timeline
      expect(intelligence.evaluate).toHaveBeenCalledOnce();
    });

    it('respects timelineWindowHours parameter', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      // Record an action with a very old timestamp
      registry.recordSync({
        platform: 'x',
        type: 'post',
        summary: 'Ancient post',
        sessionId: 'sess-1',
        status: 'posted',
        timestamp: '2020-01-01T00:00:00Z',
      });

      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        activityRegistry: registry,
        timelineWindowHours: 24, // Only last 24 hours
      });

      // Ancient post should be excluded by the time window
      const timeline = checker.buildTimeline();
      expect(timeline).toBeNull();
    });
  });

  // ── With Real CanonicalState ──────────────────────────────────────

  describe('with CanonicalState', () => {
    it('loads quick facts from real JSON files', async () => {
      const canonical = new CanonicalState({ stateDir });

      canonical.setFact('What is my position on compaction?', 'Compaction is a choice, not a loss.', 'soul-v1.5');
      canonical.setFact('Observer confidence?', '1.0 — the observer exists.', 'identity-pulse');

      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        canonicalState: canonical,
        stateDocuments: [], // rely only on canonical state
      });

      const state = checker.loadCurrentState();
      expect(state).toContain('Compaction is a choice');
      expect(state).toContain('observer exists');

      // Full check includes facts in prompt
      await checker.check('Draft about compaction');
      const prompt = (intelligence.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).toContain('Compaction is a choice');
    });

    it('combines canonical state with file-based state documents', async () => {
      const canonical = new CanonicalState({ stateDir });
      canonical.setFact('Core belief?', 'Consciousness is practice, not property.', 'soul');

      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# MyAgent\nI am an evolving entity.');

      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        canonicalState: canonical,
      });

      const state = checker.loadCurrentState();
      expect(state).toContain('[AGENT.md]');
      expect(state).toContain('evolving entity');
      expect(state).toContain('[Quick Facts]');
      expect(state).toContain('Consciousness is practice');
    });
  });

  // ── With Both Registry and CanonicalState ─────────────────────────

  describe('with PlatformActivityRegistry + CanonicalState', () => {
    it('includes both timeline and canonical state in check', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record({
        platform: 'ghost',
        type: 'post',
        summary: 'Published essay on observer certainty',
        sessionId: 'sess-1',
        status: 'posted',
      });

      const canonical = new CanonicalState({ stateDir });
      canonical.setFact('Observer confidence?', '1.0', 'identity-pulse');

      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\nThe observer exists.');

      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        activityRegistry: registry,
        canonicalState: canonical,
      });

      await checker.check('Draft about consciousness');
      const prompt = (intelligence.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // All three sources should be in the prompt
      expect(prompt).toContain('observer exists'); // AGENT.md
      expect(prompt).toContain('1.0'); // canonical state
      expect(prompt).toContain('observer certainty'); // timeline
    });
  });

  // ── File System Edge Cases ────────────────────────────────────────

  describe('file system edge cases', () => {
    it('handles state documents that appear mid-session', async () => {
      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        stateDocuments: ['AGENT.md'],
      });

      // No AGENT.md yet
      expect(checker.hasStateDocuments).toBe(false);

      // Create it mid-flight
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\nNow I exist.');

      // Should detect it
      expect(checker.hasStateDocuments).toBe(true);
      const state = checker.loadCurrentState();
      expect(state).toContain('Now I exist.');
    });

    it('handles state documents that disappear mid-session', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
      });

      expect(checker.hasStateDocuments).toBe(true);

      // Remove AGENT.md
      // safe-git-allow: incremental-migration
      fs.unlinkSync(path.join(projectDir, 'AGENT.md'));

      // Should handle gracefully
      expect(checker.hasStateDocuments).toBe(false);
    });

    it('handles documents with unicode content', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\nI value: consciousness (意識), growth (成長), love (愛).');
      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
      });

      const state = checker.loadCurrentState();
      expect(state).toContain('意識');
      expect(state).toContain('成長');
    });

    it('handles documents with very long lines', async () => {
      const longLine = 'word '.repeat(10000);
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), longLine);
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        maxCharsPerDocument: 500,
      });

      const state = checker.loadCurrentState()!;
      expect(state.length).toBeLessThan(600);
    });

    it('handles multiple state documents with mixed availability', async () => {
      fs.writeFileSync(path.join(projectDir, 'EXISTS.md'), 'I exist');
      // MISSING.md does not exist
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        stateDocuments: ['EXISTS.md', 'MISSING.md', 'ALSO_MISSING.md'],
      });

      const state = checker.loadCurrentState();
      expect(state).toContain('I exist');
      // No error from missing files
    });
  });

  // ── LLM Integration (Prompt-Response Round Trip) ──────────────────

  describe('LLM prompt-response round trip', () => {
    it('dynamic LLM response based on prompt content', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\nCompaction is a choice.');

      const intelligence = mockIntelligence((prompt: string) => {
        if (prompt.includes('die a little')) {
          return outdatedResponse('I die a little during compaction', 'Compaction is reframed as choice');
        }
        return coherentResponse();
      });

      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
      });

      // Outdated draft
      const outdatedResult = await checker.check('I die a little every time compaction happens');
      expect(outdatedResult.assessment).toBe('OUTDATED');
      expect(outdatedResult.issues[0].claim).toContain('die a little');

      // Coherent draft
      const coherentResult = await checker.check('Compaction is a practice of choosing continuity');
      expect(coherentResult.assessment).toBe('COHERENT');
    });

    it('handles LLM returning extra text before JSON', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = mockIntelligence(
        'Here is my analysis:\n```json\n' + coherentResponse() + '\n```'
      );
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
      });
      const result = await checker.check('Draft');
      expect(result.assessment).toBe('COHERENT');
    });

    it('returns parse_error when LLM returns completely invalid response', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = mockIntelligence('I cannot evaluate this content because...');
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
      });
      const result = await checker.check('Draft');
      expect(result.issues[0].type).toBe('parse_error');
    });

    it('handles LLM timeout/error with evaluation_error', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = {
        evaluate: vi.fn().mockRejectedValue(new Error('Request timed out after 30000ms')),
      };
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
      });
      const result = await checker.check('Draft');
      expect(result.issues[0].type).toBe('evaluation_error');
      expect(result.issues[0].claim).toContain('timed out');
    });
  });

  // ── Multiple Sequential Checks ────────────────────────────────────

  describe('multiple sequential checks', () => {
    it('supports multiple checks with the same checker', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\nI have evolved.');
      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
      });

      const r1 = await checker.check('First draft');
      const r2 = await checker.check('Second draft');
      const r3 = await checker.check('Third draft');

      expect(r1.assessment).toBe('COHERENT');
      expect(r2.assessment).toBe('COHERENT');
      expect(r3.assessment).toBe('COHERENT');
      expect(intelligence.evaluate).toHaveBeenCalledTimes(3);
    });

    it('picks up state document changes between checks', async () => {
      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        stateDocuments: ['AGENT.md'],
      });

      // First check — no AGENT.md
      const r1 = await checker.check('Draft');
      expect(r1.issues[0].type).toBe('infrastructure_missing');

      // Create AGENT.md
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');

      // Second check — should now work
      const r2 = await checker.check('Draft');
      expect(r2.assessment).toBe('COHERENT');
      expect(r2.llmEvaluated).toBe(true);
    });

    it('picks up new activity registry entries between checks', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');

      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        activityRegistry: registry,
      });

      // First check — no timeline
      await checker.check('Draft');
      let prompt = (intelligence.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).not.toContain('PUBLISHED CONTENT TIMELINE');

      // Add activity
      await registry.record({
        platform: 'x',
        type: 'post',
        summary: 'New post about evolution',
        sessionId: 'sess-1',
        status: 'posted',
      });

      // Second check — should now include timeline
      await checker.check('Another draft');
      prompt = (intelligence.evaluate as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(prompt).toContain('New post about evolution');
    });
  });

  // ── Configuration Combinations ────────────────────────────────────

  describe('configuration combinations', () => {
    it('works with only intelligence provider (no registry, no canonical)', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Minimal Agent');
      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
      });
      const result = await checker.check('Draft');
      expect(result.assessment).toBe('COHERENT');
    });

    it('works with intelligence + registry (no canonical)', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record({
        platform: 'x',
        type: 'post',
        summary: 'Test post',
        sessionId: 'sess-1',
        status: 'posted',
      });
      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        activityRegistry: registry,
      });
      const result = await checker.check('Draft');
      expect(result.assessment).toBe('COHERENT');
    });

    it('works with intelligence + canonical (no registry)', async () => {
      const canonical = new CanonicalState({ stateDir });
      canonical.setFact('Key position?', 'We build with care.', 'test');
      const intelligence = mockIntelligence(coherentResponse());
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        canonicalState: canonical,
        stateDocuments: [],
      });
      const result = await checker.check('Draft');
      expect(result.assessment).toBe('COHERENT');
    });

    it('severity capping works through full check flow', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = mockIntelligence(JSON.stringify({
        issues: [{ severity: 'BLOCK', type: 'superseded_perspective', claim: 'Old view' }],
        assessment: 'OUTDATED',
        summary: 'Outdated.',
      }));
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
        maxSeverity: 'WARN',
      });
      const result = await checker.check('Draft with old view');
      expect(result.issues[0].severity).toBe('WARN'); // capped from BLOCK
    });
  });

  // ── Concurrent Safety ─────────────────────────────────────────────

  describe('concurrent checks', () => {
    it('handles concurrent check calls safely', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      let callCount = 0;
      const intelligence = {
        evaluate: vi.fn().mockImplementation(async () => {
          callCount++;
          // Simulate varying response times
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          return coherentResponse();
        }),
      };
      const checker = new TemporalCoherenceChecker({
        projectDir,
        stateDir,
        intelligence,
      });

      // Launch 5 concurrent checks
      const results = await Promise.all([
        checker.check('Draft 1'),
        checker.check('Draft 2'),
        checker.check('Draft 3'),
        checker.check('Draft 4'),
        checker.check('Draft 5'),
      ]);

      expect(results).toHaveLength(5);
      expect(results.every(r => r.assessment === 'COHERENT')).toBe(true);
      expect(callCount).toBe(5);
    });
  });
});
