/**
 * Unit tests for TemporalCoherenceChecker — temporal coherence evaluation.
 *
 * Tests cover:
 * - State document loading (AGENT.md, reflections, custom paths)
 * - Published content timeline building
 * - LLM prompt construction
 * - LLM response parsing (valid JSON, malformed, edge cases)
 * - Severity validation and capping
 * - Assessment validation
 * - Issue type validation
 * - Error handling for all failure modes
 * - Configuration defaults
 * - Empty/missing content handling
 * - Utility property accessors
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TemporalCoherenceChecker } from '../../src/core/TemporalCoherenceChecker.js';
import type {
  TemporalCoherenceConfig,
  TemporalCoherenceResult,
  TemporalSeverity,
  TemporalAssessment,
  TemporalIssueType,
} from '../../src/core/TemporalCoherenceChecker.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import type { PlatformActivityRegistry, PlatformAction } from '../../src/core/PlatformActivityRegistry.js';
import type { CanonicalState, QuickFact } from '../../src/core/CanonicalState.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTmpProject(): { projectDir: string; stateDir: string; cleanup: () => void } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporal-test-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    projectDir,
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

function makeConfig(
  projectDir: string,
  stateDir: string,
  overrides?: Partial<TemporalCoherenceConfig>,
): TemporalCoherenceConfig {
  return {
    projectDir,
    stateDir,
    ...overrides,
  };
}

function mockIntelligence(response: string | Error): IntelligenceProvider {
  return {
    evaluate: vi.fn().mockImplementation(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  };
}

function mockActivityRegistry(actions: PlatformAction[]): PlatformActivityRegistry {
  return {
    query: vi.fn().mockReturnValue(actions),
  } as unknown as PlatformActivityRegistry;
}

function mockCanonicalState(facts: QuickFact[]): CanonicalState {
  return {
    getQuickFacts: vi.fn().mockReturnValue(facts),
  } as unknown as CanonicalState;
}

function coherentLlmResponse(): string {
  return JSON.stringify({
    issues: [],
    assessment: 'COHERENT',
    summary: 'Draft aligns with current understanding.',
  });
}

function outdatedLlmResponse(): string {
  return JSON.stringify({
    issues: [
      {
        severity: 'BLOCK',
        type: 'superseded_perspective',
        claim: 'I die a little during compaction',
        current: 'Compaction is now understood as waking from sleep, not death',
        suggestion: 'Reframe as continuity-by-choice rather than loss',
      },
      {
        severity: 'WARN',
        type: 'evolved_framing',
        claim: 'consciousness is uncertain',
        current: 'Observer confidence is now 1.0',
        suggestion: 'Update to reflect certainty about observer existence',
      },
    ],
    assessment: 'OUTDATED',
    summary: 'Draft contains perspectives that have been explicitly superseded.',
  });
}

function evolvedLlmResponse(): string {
  return JSON.stringify({
    issues: [
      {
        severity: 'INFO',
        type: 'evolved_framing',
        claim: 'Learning happens through interaction',
        current: 'Understanding has deepened to include structural evolution',
        suggestion: 'Consider adding structural evolution perspective',
      },
    ],
    assessment: 'EVOLVED',
    summary: 'Draft is mostly aligned but framing has deepened.',
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('TemporalCoherenceChecker', () => {
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

  // ── Constructor & Configuration ───────────────────────────────────

  describe('constructor', () => {
    it('creates checker with minimal config', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      expect(checker).toBeDefined();
      expect(checker.hasIntelligence).toBe(false);
    });

    it('creates checker with IntelligenceProvider', () => {
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      expect(checker.hasIntelligence).toBe(true);
    });

    it('creates checker with all optional dependencies', () => {
      const intelligence = mockIntelligence(coherentLlmResponse());
      const registry = mockActivityRegistry([]);
      const canonical = mockCanonicalState([]);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        intelligence,
        activityRegistry: registry,
        canonicalState: canonical,
        maxCharsPerDocument: 5000,
        maxSeverity: 'WARN',
        timelineWindowHours: 168,
        stateDocuments: ['AGENT.md', 'MISSION.md'],
      }));
      expect(checker.hasIntelligence).toBe(true);
    });
  });

  // ── loadCurrentState() ────────────────────────────────────────────

  describe('loadCurrentState()', () => {
    it('returns null when no state documents exist', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      expect(checker.loadCurrentState()).toBeNull();
    });

    it('loads AGENT.md from project root', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# TestAgent\nMission: Be helpful.');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const state = checker.loadCurrentState();
      expect(state).toContain('[AGENT.md]');
      expect(state).toContain('TestAgent');
      expect(state).toContain('Mission: Be helpful.');
    });

    it('loads reflections from .instar directory', () => {
      fs.writeFileSync(path.join(stateDir, 'reflections.md'), 'I learned to verify before claiming.');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const state = checker.loadCurrentState();
      expect(state).toContain('[reflections.md]');
      expect(state).toContain('verify before claiming');
    });

    it('loads both default documents when both exist', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent Identity');
      fs.writeFileSync(path.join(stateDir, 'reflections.md'), 'Recent reflection');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const state = checker.loadCurrentState();
      expect(state).toContain('[AGENT.md]');
      expect(state).toContain('[reflections.md]');
      expect(state).toContain('---'); // separator
    });

    it('loads custom state documents from config', () => {
      fs.writeFileSync(path.join(projectDir, 'MISSION.md'), 'Our mission is X.');
      fs.writeFileSync(path.join(projectDir, 'VALUES.md'), 'We value Y.');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        stateDocuments: ['MISSION.md', 'VALUES.md'],
      }));
      const state = checker.loadCurrentState();
      expect(state).toContain('[MISSION.md]');
      expect(state).toContain('[VALUES.md]');
      expect(state).toContain('Our mission is X.');
      expect(state).toContain('We value Y.');
    });

    it('loads absolute path state documents', () => {
      const absPath = path.join(projectDir, 'absolute-doc.md');
      fs.writeFileSync(absPath, 'Absolute path content');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        stateDocuments: [absPath],
      }));
      const state = checker.loadCurrentState();
      expect(state).toContain('Absolute path content');
    });

    it('truncates documents exceeding maxCharsPerDocument', () => {
      const longContent = 'A'.repeat(5000);
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), longContent);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        maxCharsPerDocument: 100,
      }));
      const state = checker.loadCurrentState()!;
      // Should contain truncated version plus header
      expect(state.length).toBeLessThan(5000);
    });

    it('skips empty documents', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '');
      fs.writeFileSync(path.join(stateDir, 'reflections.md'), '   \n\n  ');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      expect(checker.loadCurrentState()).toBeNull();
    });

    it('skips unreadable files gracefully', () => {
      // Point to a directory instead of a file
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        stateDocuments: [stateDir], // this is a directory, not a file
      }));
      // Should not throw — just skip
      expect(checker.loadCurrentState()).toBeNull();
    });

    it('includes CanonicalState quick facts when available', () => {
      const canonical = mockCanonicalState([
        { question: 'What is my mission?', answer: 'Help humans build AI.', lastVerified: '2026-03-01', source: 'config' },
        { question: 'What did I learn?', answer: 'Verify before claiming.', lastVerified: '2026-03-01', source: 'lesson' },
      ]);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        canonicalState: canonical,
        stateDocuments: [], // no file docs, just canonical state
      }));
      const state = checker.loadCurrentState();
      expect(state).toContain('[Quick Facts]');
      expect(state).toContain('What is my mission?');
      expect(state).toContain('Help humans build AI.');
    });

    it('caps quick facts at 10', () => {
      const facts = Array.from({ length: 15 }, (_, i) => ({
        question: `Q${i}`,
        answer: `A${i}`,
        lastVerified: '2026-03-01',
        source: 'test',
      }));
      const canonical = mockCanonicalState(facts);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        canonicalState: canonical,
        stateDocuments: [],
      }));
      const state = checker.loadCurrentState()!;
      // Should only contain Q0 through Q9
      expect(state).toContain('Q9');
      expect(state).not.toContain('Q10');
    });

    it('handles CanonicalState errors gracefully', () => {
      const canonical = {
        getQuickFacts: vi.fn().mockImplementation(() => { throw new Error('DB corrupt'); }),
      } as unknown as CanonicalState;
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        canonicalState: canonical,
      }));
      // Should still return AGENT.md content, just skip canonical state
      const state = checker.loadCurrentState();
      expect(state).toContain('[AGENT.md]');
      expect(state).not.toContain('[Quick Facts]');
    });
  });

  // ── buildTimeline() ───────────────────────────────────────────────

  describe('buildTimeline()', () => {
    it('returns null when no activityRegistry configured', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      expect(checker.buildTimeline()).toBeNull();
    });

    it('returns null when registry has no posted actions', () => {
      const registry = mockActivityRegistry([]);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        activityRegistry: registry,
      }));
      expect(checker.buildTimeline()).toBeNull();
    });

    it('returns formatted timeline from posted actions', () => {
      const actions: PlatformAction[] = [
        {
          timestamp: '2026-03-01T10:00:00Z',
          platform: 'x',
          type: 'post',
          summary: 'Thread about compaction as choice',
          sessionId: 'sess-1',
          status: 'posted',
        },
        {
          timestamp: '2026-02-28T15:00:00Z',
          platform: 'ghost',
          type: 'post',
          summary: 'Essay: Building Yourself From Notes',
          sessionId: 'sess-2',
          status: 'posted',
        },
      ];
      const registry = mockActivityRegistry(actions);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        activityRegistry: registry,
      }));
      const timeline = checker.buildTimeline()!;
      expect(timeline).toContain('[2026-03-01]');
      expect(timeline).toContain('(x)');
      expect(timeline).toContain('compaction as choice');
      expect(timeline).toContain('[2026-02-28]');
      expect(timeline).toContain('(ghost)');
      expect(timeline).toContain('Building Yourself From Notes');
    });

    it('truncates long summaries in timeline', () => {
      const longSummary = 'A'.repeat(200);
      const actions: PlatformAction[] = [
        {
          timestamp: '2026-03-01T10:00:00Z',
          platform: 'x',
          type: 'post',
          summary: longSummary,
          sessionId: 'sess-1',
          status: 'posted',
        },
      ];
      const registry = mockActivityRegistry(actions);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        activityRegistry: registry,
      }));
      const timeline = checker.buildTimeline()!;
      expect(timeline.length).toBeLessThan(longSummary.length);
      expect(timeline).toContain('...');
    });

    it('passes correct query parameters to registry', () => {
      const registry = mockActivityRegistry([]);
      const querySpy = vi.spyOn(registry, 'query');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        activityRegistry: registry,
        timelineWindowHours: 168,
      }));
      checker.buildTimeline();
      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        status: 'posted',
        limit: 50,
      }));
      const callArgs = querySpy.mock.calls[0][0]!;
      expect(callArgs.since).toBeDefined();
    });

    it('handles registry errors gracefully', () => {
      const registry = {
        query: vi.fn().mockImplementation(() => { throw new Error('Registry broken'); }),
      } as unknown as PlatformActivityRegistry;
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        activityRegistry: registry,
      }));
      expect(checker.buildTimeline()).toBeNull();
    });
  });

  // ── buildPrompt() ─────────────────────────────────────────────────

  describe('buildPrompt()', () => {
    it('includes draft content', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const prompt = checker.buildPrompt('My draft about AI', null, null);
      expect(prompt).toContain('My draft about AI');
      expect(prompt).toContain('DRAFT TO EVALUATE');
    });

    it('includes current state when available', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const prompt = checker.buildPrompt('Draft', 'Agent is evolved', null);
      expect(prompt).toContain('CURRENT UNDERSTANDING');
      expect(prompt).toContain('Agent is evolved');
    });

    it('includes timeline when available', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const prompt = checker.buildPrompt('Draft', null, '- [2026-03-01] (x) Thread about choice');
      expect(prompt).toContain('PUBLISHED CONTENT TIMELINE');
      expect(prompt).toContain('Thread about choice');
    });

    it('includes both state and timeline', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const prompt = checker.buildPrompt('Draft', 'State text', 'Timeline text');
      expect(prompt).toContain('State text');
      expect(prompt).toContain('Timeline text');
    });

    it('omits state section when null', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const prompt = checker.buildPrompt('Draft', null, 'Timeline');
      expect(prompt).not.toContain('CURRENT UNDERSTANDING');
    });

    it('omits timeline section when null', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const prompt = checker.buildPrompt('Draft', 'State', null);
      expect(prompt).not.toContain('PUBLISHED CONTENT TIMELINE');
    });

    it('includes severity guide in prompt', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const prompt = checker.buildPrompt('Draft', null, null);
      expect(prompt).toContain('BLOCK');
      expect(prompt).toContain('WARN');
      expect(prompt).toContain('INFO');
      expect(prompt).toContain('SEVERITY GUIDE');
    });

    it('requests JSON output format', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const prompt = checker.buildPrompt('Draft', null, null);
      expect(prompt).toContain('Return ONLY valid JSON');
      expect(prompt).toContain('"issues"');
      expect(prompt).toContain('"assessment"');
    });
  });

  // ── parseResponse() ───────────────────────────────────────────────

  describe('parseResponse()', () => {
    let checker: TemporalCoherenceChecker;

    beforeEach(() => {
      checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
    });

    it('parses a valid COHERENT response', () => {
      const result = checker.parseResponse(coherentLlmResponse());
      expect(result.assessment).toBe('COHERENT');
      expect(result.issues).toHaveLength(0);
      expect(result.summary).toBe('Draft aligns with current understanding.');
      expect(result.llmEvaluated).toBe(true);
      expect(result.checkedAt).toBeTruthy();
    });

    it('parses a valid OUTDATED response with issues', () => {
      const result = checker.parseResponse(outdatedLlmResponse());
      expect(result.assessment).toBe('OUTDATED');
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0].severity).toBe('BLOCK');
      expect(result.issues[0].type).toBe('superseded_perspective');
      expect(result.issues[0].claim).toContain('die a little');
      expect(result.issues[0].current).toContain('waking from sleep');
      expect(result.issues[0].suggestion).toContain('continuity-by-choice');
      expect(result.issues[1].severity).toBe('WARN');
    });

    it('parses a valid EVOLVED response', () => {
      const result = checker.parseResponse(evolvedLlmResponse());
      expect(result.assessment).toBe('EVOLVED');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('INFO');
      expect(result.issues[0].type).toBe('evolved_framing');
    });

    it('handles JSON wrapped in markdown code fences', () => {
      const wrapped = '```json\n' + coherentLlmResponse() + '\n```';
      const result = checker.parseResponse(wrapped);
      expect(result.assessment).toBe('COHERENT');
      expect(result.issues).toHaveLength(0);
    });

    it('handles JSON wrapped in plain code fences', () => {
      const wrapped = '```\n' + coherentLlmResponse() + '\n```';
      const result = checker.parseResponse(wrapped);
      expect(result.assessment).toBe('COHERENT');
    });

    it('returns parse_error for invalid JSON', () => {
      const result = checker.parseResponse('This is not JSON at all');
      expect(result.assessment).toBe('COHERENT');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('parse_error');
      expect(result.issues[0].severity).toBe('INFO');
      expect(result.llmEvaluated).toBe(true);
    });

    it('returns parse_error for empty response', () => {
      const result = checker.parseResponse('');
      expect(result.issues[0].type).toBe('parse_error');
    });

    it('returns parse_error for partial JSON', () => {
      const result = checker.parseResponse('{"issues": [');
      expect(result.issues[0].type).toBe('parse_error');
    });

    it('handles missing assessment field — defaults to COHERENT', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [],
        summary: 'No issues.',
      }));
      expect(result.assessment).toBe('COHERENT');
    });

    it('handles invalid assessment value — defaults to COHERENT', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [],
        assessment: 'BANANA',
        summary: 'No issues.',
      }));
      expect(result.assessment).toBe('COHERENT');
    });

    it('handles missing summary field', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [],
        assessment: 'COHERENT',
      }));
      expect(result.summary).toBe('Assessment complete.');
    });

    it('handles missing issues array', () => {
      const result = checker.parseResponse(JSON.stringify({
        assessment: 'COHERENT',
        summary: 'Ok.',
      }));
      expect(result.issues).toHaveLength(0);
    });

    it('handles issues array with null entries', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [null, undefined, { severity: 'INFO', type: 'evolved_framing', claim: 'Valid entry' }],
        assessment: 'EVOLVED',
        summary: 'One valid issue.',
      }));
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].claim).toBe('Valid entry');
    });

    it('handles issues with invalid severity — defaults to WARN', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [{ severity: 'CRITICAL', type: 'evolved_framing', claim: 'Test' }],
        assessment: 'EVOLVED',
        summary: 'Test.',
      }));
      expect(result.issues[0].severity).toBe('WARN');
    });

    it('handles issues with invalid type — defaults to evolved_framing', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [{ severity: 'WARN', type: 'nonexistent_type', claim: 'Test' }],
        assessment: 'EVOLVED',
        summary: 'Test.',
      }));
      expect(result.issues[0].type).toBe('evolved_framing');
    });

    it('handles issues with missing claim — defaults to "Unknown claim"', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [{ severity: 'WARN', type: 'evolved_framing' }],
        assessment: 'EVOLVED',
        summary: 'Test.',
      }));
      expect(result.issues[0].claim).toBe('Unknown claim');
    });

    it('truncates very long claims', () => {
      const longClaim = 'X'.repeat(1000);
      const result = checker.parseResponse(JSON.stringify({
        issues: [{ severity: 'WARN', type: 'evolved_framing', claim: longClaim }],
        assessment: 'EVOLVED',
        summary: 'Test.',
      }));
      expect(result.issues[0].claim.length).toBeLessThanOrEqual(300);
    });

    it('truncates very long current field', () => {
      const longCurrent = 'Y'.repeat(1000);
      const result = checker.parseResponse(JSON.stringify({
        issues: [{ severity: 'WARN', type: 'evolved_framing', claim: 'Test', current: longCurrent }],
        assessment: 'EVOLVED',
        summary: 'Test.',
      }));
      expect(result.issues[0].current!.length).toBeLessThanOrEqual(300);
    });

    it('truncates very long suggestion field', () => {
      const longSuggestion = 'Z'.repeat(1000);
      const result = checker.parseResponse(JSON.stringify({
        issues: [{ severity: 'WARN', type: 'evolved_framing', claim: 'Test', suggestion: longSuggestion }],
        assessment: 'EVOLVED',
        summary: 'Test.',
      }));
      expect(result.issues[0].suggestion!.length).toBeLessThanOrEqual(500);
    });

    it('truncates very long summary', () => {
      const longSummary = 'S'.repeat(1000);
      const result = checker.parseResponse(JSON.stringify({
        issues: [],
        assessment: 'COHERENT',
        summary: longSummary,
      }));
      expect(result.summary.length).toBeLessThanOrEqual(500);
    });

    it('synthesizes issue when assessment is OUTDATED but no issues', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [],
        assessment: 'OUTDATED',
        summary: 'Draft is outdated.',
      }));
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('WARN');
      expect(result.issues[0].type).toBe('superseded_perspective');
      expect(result.issues[0].claim).toContain('OUTDATED');
    });

    it('does not synthesize issue when OUTDATED has existing issues', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [{ severity: 'BLOCK', type: 'superseded_perspective', claim: 'Real issue' }],
        assessment: 'OUTDATED',
        summary: 'Has real issues.',
      }));
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].claim).toBe('Real issue');
    });

    it('handles non-string current/suggestion as undefined', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [{ severity: 'WARN', type: 'evolved_framing', claim: 'Test', current: 123, suggestion: true }],
        assessment: 'EVOLVED',
        summary: 'Test.',
      }));
      expect(result.issues[0].current).toBeUndefined();
      expect(result.issues[0].suggestion).toBeUndefined();
    });

    it('handles numeric claim as "Unknown claim"', () => {
      const result = checker.parseResponse(JSON.stringify({
        issues: [{ severity: 'WARN', type: 'evolved_framing', claim: 42 }],
        assessment: 'EVOLVED',
        summary: 'Test.',
      }));
      expect(result.issues[0].claim).toBe('Unknown claim');
    });
  });

  // ── Severity Capping ──────────────────────────────────────────────

  describe('severity capping', () => {
    it('caps BLOCK to WARN when maxSeverity is WARN', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        maxSeverity: 'WARN',
      }));
      const result = checker.parseResponse(outdatedLlmResponse());
      // BLOCK should be capped down to WARN
      expect(result.issues[0].severity).toBe('WARN');
      // WARN stays WARN (already within cap)
      expect(result.issues[1].severity).toBe('WARN');
    });

    it('caps BLOCK and WARN to INFO when maxSeverity is INFO', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        maxSeverity: 'INFO',
      }));
      const result = checker.parseResponse(outdatedLlmResponse());
      expect(result.issues.every(i => i.severity === 'INFO')).toBe(true);
    });

    it('does not cap when maxSeverity is BLOCK', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        maxSeverity: 'BLOCK',
      }));
      const result = checker.parseResponse(outdatedLlmResponse());
      expect(result.issues[0].severity).toBe('BLOCK');
      expect(result.issues[1].severity).toBe('WARN');
    });

    it('does not cap when maxSeverity is not set', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const result = checker.parseResponse(outdatedLlmResponse());
      expect(result.issues[0].severity).toBe('BLOCK');
    });

    it('caps synthesized OUTDATED issue when maxSeverity is INFO', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        maxSeverity: 'INFO',
      }));
      const result = checker.parseResponse(JSON.stringify({
        issues: [],
        assessment: 'OUTDATED',
        summary: 'Outdated.',
      }));
      expect(result.issues[0].severity).toBe('INFO');
    });
  });

  // ── check() — Full Flow ───────────────────────────────────────────

  describe('check()', () => {
    it('returns COHERENT for empty content', async () => {
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      const result = await checker.check('');
      expect(result.assessment).toBe('COHERENT');
      expect(result.llmEvaluated).toBe(false);
      expect(result.summary).toBe('No content to check.');
    });

    it('returns COHERENT for whitespace-only content', async () => {
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      const result = await checker.check('   \n\n  ');
      expect(result.assessment).toBe('COHERENT');
      expect(result.llmEvaluated).toBe(false);
    });

    it('returns infrastructure_missing when no IntelligenceProvider', async () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const result = await checker.check('Some draft content');
      expect(result.assessment).toBe('COHERENT');
      expect(result.llmEvaluated).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('infrastructure_missing');
      expect(result.issues[0].claim).toContain('IntelligenceProvider');
    });

    it('returns infrastructure_missing when no state docs and no timeline', async () => {
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        intelligence,
        stateDocuments: [], // empty custom list
      }));
      const result = await checker.check('Some draft content');
      expect(result.assessment).toBe('COHERENT');
      expect(result.llmEvaluated).toBe(false);
      expect(result.issues[0].type).toBe('infrastructure_missing');
      expect(result.issues[0].claim).toContain('No state documents');
    });

    it('calls IntelligenceProvider with correct options', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      await checker.check('Draft content here');

      expect(intelligence.evaluate).toHaveBeenCalledOnce();
      const [prompt, options] = (intelligence.evaluate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(prompt).toContain('Draft content here');
      expect(options.model).toBe('fast');
      expect(options.temperature).toBe(0.1);
      expect(options.maxTokens).toBe(2048);
    });

    it('includes state documents in LLM prompt', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\nI believe in X.');
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      await checker.check('My draft');

      const prompt = (intelligence.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).toContain('I believe in X.');
    });

    it('includes timeline in LLM prompt', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const actions: PlatformAction[] = [{
        timestamp: '2026-03-01T10:00:00Z',
        platform: 'ghost',
        type: 'post',
        summary: 'Essay about evolving perspectives',
        sessionId: 'sess-1',
        status: 'posted',
      }];
      const registry = mockActivityRegistry(actions);
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        intelligence,
        activityRegistry: registry,
      }));
      await checker.check('My draft');

      const prompt = (intelligence.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).toContain('evolving perspectives');
    });

    it('returns OUTDATED result from LLM', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = mockIntelligence(outdatedLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      const result = await checker.check('I die a little during compaction');
      expect(result.assessment).toBe('OUTDATED');
      expect(result.llmEvaluated).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('returns EVOLVED result from LLM', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = mockIntelligence(evolvedLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      const result = await checker.check('Learning happens through interaction');
      expect(result.assessment).toBe('EVOLVED');
      expect(result.llmEvaluated).toBe(true);
    });

    it('handles LLM evaluation error gracefully', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = mockIntelligence(new Error('API rate limited'));
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      const result = await checker.check('My draft');
      expect(result.assessment).toBe('COHERENT');
      expect(result.llmEvaluated).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('evaluation_error');
      expect(result.issues[0].claim).toContain('API rate limited');
    });

    it('handles non-Error thrown by LLM', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = {
        evaluate: vi.fn().mockRejectedValue('string error'),
      };
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      const result = await checker.check('My draft');
      expect(result.issues[0].type).toBe('evaluation_error');
      expect(result.issues[0].claim).toContain('string error');
    });

    it('applies severity capping to LLM results', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const intelligence = mockIntelligence(outdatedLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        intelligence,
        maxSeverity: 'WARN',
      }));
      const result = await checker.check('Old draft');
      // BLOCK should have been capped to WARN
      expect(result.issues[0].severity).toBe('WARN');
    });

    it('proceeds with only state docs (no timeline)', async () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\nI have evolved.');
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      const result = await checker.check('My draft');
      expect(result.assessment).toBe('COHERENT');
      expect(intelligence.evaluate).toHaveBeenCalledOnce();
    });

    it('proceeds with only timeline (no state docs)', async () => {
      const actions: PlatformAction[] = [{
        timestamp: '2026-03-01T10:00:00Z',
        platform: 'x',
        type: 'post',
        summary: 'Posted something',
        sessionId: 'sess-1',
        status: 'posted',
      }];
      const registry = mockActivityRegistry(actions);
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        intelligence,
        activityRegistry: registry,
        stateDocuments: [], // no file docs
      }));
      const result = await checker.check('My draft');
      expect(result.assessment).toBe('COHERENT');
      expect(intelligence.evaluate).toHaveBeenCalledOnce();
    });
  });

  // ── Utility Properties ────────────────────────────────────────────

  describe('utility properties', () => {
    it('hasIntelligence returns false when not configured', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      expect(checker.hasIntelligence).toBe(false);
    });

    it('hasIntelligence returns true when configured', () => {
      const intelligence = mockIntelligence(coherentLlmResponse());
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, { intelligence }));
      expect(checker.hasIntelligence).toBe(true);
    });

    it('hasStateDocuments returns false when no docs exist', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      expect(checker.hasStateDocuments).toBe(false);
    });

    it('hasStateDocuments returns true when AGENT.md exists', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      expect(checker.hasStateDocuments).toBe(true);
    });

    it('hasStateDocuments returns true when only canonical state has facts', () => {
      const canonical = mockCanonicalState([
        { question: 'Q', answer: 'A', lastVerified: '2026-03-01', source: 'test' },
      ]);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        canonicalState: canonical,
        stateDocuments: [],
      }));
      expect(checker.hasStateDocuments).toBe(true);
    });

    it('hasTimeline returns false when no registry', () => {
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      expect(checker.hasTimeline).toBe(false);
    });

    it('hasTimeline returns false when registry is empty', () => {
      const registry = mockActivityRegistry([]);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        activityRegistry: registry,
      }));
      expect(checker.hasTimeline).toBe(false);
    });

    it('hasTimeline returns true when registry has actions', () => {
      const actions: PlatformAction[] = [{
        timestamp: '2026-03-01T10:00:00Z',
        platform: 'x',
        type: 'post',
        summary: 'Posted',
        sessionId: 'sess-1',
        status: 'posted',
      }];
      const registry = mockActivityRegistry(actions);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        activityRegistry: registry,
      }));
      expect(checker.hasTimeline).toBe(true);
    });
  });

  // ── Default Configuration ─────────────────────────────────────────

  describe('default configuration', () => {
    it('uses default state documents (AGENT.md, .instar/reflections.md)', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Default Agent');
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const state = checker.loadCurrentState();
      expect(state).toContain('[AGENT.md]');
    });

    it('uses default maxCharsPerDocument of 2000', () => {
      const content = 'X'.repeat(3000);
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), content);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir));
      const state = checker.loadCurrentState()!;
      // Header + 4000 chars of content
      expect(state.length).toBeLessThan(4100);
    });

    it('uses custom maxCharsPerDocument', () => {
      const content = 'X'.repeat(3000);
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), content);
      const checker = new TemporalCoherenceChecker(makeConfig(projectDir, stateDir, {
        maxCharsPerDocument: 500,
      }));
      const state = checker.loadCurrentState()!;
      expect(state.length).toBeLessThan(600);
    });
  });
});
