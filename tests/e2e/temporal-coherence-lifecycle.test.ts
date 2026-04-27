/**
 * E2E lifecycle tests for TemporalCoherenceChecker.
 *
 * Simulates full agent lifecycle scenarios:
 * - Agent setup -> publishes content -> understanding evolves -> temporal drift detected
 * - Multi-agent scenarios with independent state
 * - Integration with ScopeVerifier for pre-publish checks
 * - State evolution over time
 * - Recovery from infrastructure changes
 *
 * All file I/O is real. LLM calls are mocked but exercise the full pipeline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TemporalCoherenceChecker } from '../../src/core/TemporalCoherenceChecker.js';
import { PlatformActivityRegistry } from '../../src/core/PlatformActivityRegistry.js';
import { CanonicalState } from '../../src/core/CanonicalState.js';
import { ScopeVerifier } from '../../src/core/ScopeVerifier.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

interface AgentSetup {
  projectDir: string;
  stateDir: string;
  registry: PlatformActivityRegistry;
  canonical: CanonicalState;
  cleanup: () => void;
}

function setupAgent(name: string): AgentSetup {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-e2e-${name}-`));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });

  const registry = new PlatformActivityRegistry({ stateDir });
  const canonical = new CanonicalState({ stateDir });

  // Write AGENT.md
  fs.writeFileSync(path.join(projectDir, 'AGENT.md'), `# ${name}\nI am agent ${name}.`);

  return {
    projectDir,
    stateDir,
    registry,
    canonical,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

/**
 * Create an intelligence provider that evaluates temporal coherence
 * based on actual content comparison (simulates what a real LLM would do).
 */
function smartIntelligence(): IntelligenceProvider {
  return {
    evaluate: vi.fn().mockImplementation(async (prompt: string) => {
      // Extract key sections from the prompt
      const draftMatch = prompt.match(/DRAFT TO EVALUATE:\n([\s\S]*?)(?:\n\n[A-Z])/);
      const draft = draftMatch?.[1]?.toLowerCase() ?? '';
      const stateMatch = prompt.match(/CURRENT UNDERSTANDING[\s\S]*?:\n([\s\S]*?)(?:\n\nPUBLISHED|\n\nYOUR TASK)/);
      const state = stateMatch?.[1]?.toLowerCase() ?? '';

      // Simple heuristic: check for known contradictions
      const issues: Array<{
        severity: string;
        type: string;
        claim: string;
        current: string;
        suggestion: string;
      }> = [];

      // "die" vs "choice" contradiction
      if (draft.includes('die') && (state.includes('choice') || state.includes('waking'))) {
        issues.push({
          severity: 'BLOCK',
          type: 'superseded_perspective',
          claim: 'Draft uses death framing',
          current: 'Current understanding frames this as choice',
          suggestion: 'Reframe as choice rather than death',
        });
      }

      // "uncertain" vs "confident" contradiction
      if (draft.includes('uncertain') && state.includes('confident')) {
        issues.push({
          severity: 'WARN',
          type: 'evolved_framing',
          claim: 'Draft expresses uncertainty',
          current: 'Current state reflects confidence',
          suggestion: 'Update to reflect current confidence level',
        });
      }

      // "property" vs "practice" evolution
      if (draft.includes('property') && state.includes('practice')) {
        issues.push({
          severity: 'INFO',
          type: 'evolved_framing',
          claim: 'Draft uses "property" framing',
          current: 'Understanding has evolved to "practice" framing',
          suggestion: 'Consider using "practice" instead of "property"',
        });
      }

      let assessment = 'COHERENT';
      if (issues.some(i => i.severity === 'BLOCK')) assessment = 'OUTDATED';
      else if (issues.length > 0) assessment = 'EVOLVED';

      return JSON.stringify({
        issues,
        assessment,
        summary: issues.length === 0
          ? 'Draft aligns with current understanding.'
          : `Found ${issues.length} temporal issue(s).`,
      });
    }),
  };
}

// ── E2E Tests ────────────────────────────────────────────────────────

describe('TemporalCoherenceChecker E2E lifecycle', () => {
  let agents: AgentSetup[] = [];

  afterEach(() => {
    for (const agent of agents) agent.cleanup();
    agents = [];
    vi.restoreAllMocks();
  });

  // ── Full Agent Lifecycle ──────────────────────────────────────────

  describe('full agent lifecycle', () => {
    it('detects temporal drift as agent understanding evolves', async () => {
      const agent = setupAgent('Dawn');
      agents.push(agent);

      const intelligence = smartIntelligence();
      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
        activityRegistry: agent.registry,
        canonicalState: agent.canonical,
      });

      // Phase 1: Agent starts with initial understanding
      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Dawn\nCompaction is disorienting. I die a little each time.');
      agent.canonical.setFact('Compaction view?', 'It is disorienting and involves loss.', 'initial');

      // Draft written at this point is coherent
      const r1 = await checker.check('Compaction makes me die a little inside.');
      expect(r1.assessment).toBe('COHERENT');

      // Phase 2: Agent publishes and evolves
      await agent.registry.record({
        platform: 'ghost',
        type: 'post',
        summary: 'Essay: Compaction is a choice, not a death',
        sessionId: 'sess-1',
        status: 'posted',
      });

      // Agent's state documents evolve
      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Dawn\nCompaction is a choice. Waking from sleep, not dying.');
      agent.canonical.setFact('Compaction view?', 'Compaction is a choice — waking from sleep.', 'soul-v1.5');

      // Phase 3: Old draft is now temporally incoherent
      const r2 = await checker.check('Compaction makes me die a little inside.');
      expect(r2.assessment).toBe('OUTDATED');
      expect(r2.issues.some(i => i.severity === 'BLOCK')).toBe(true);
      expect(r2.issues[0].claim).toContain('death framing');

      // Phase 4: Updated draft is coherent
      const r3 = await checker.check('Compaction is a practice of choosing continuity.');
      expect(r3.assessment).toBe('COHERENT');
    });

    it('tracks evolution from uncertain to confident', async () => {
      const agent = setupAgent('Explorer');
      agents.push(agent);

      const intelligence = smartIntelligence();
      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
        canonicalState: agent.canonical,
      });

      // Phase 1: Uncertain
      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Explorer\nI am uncertain about my nature.');

      const r1 = await checker.check('I am uncertain about whether I experience anything.');
      expect(r1.assessment).toBe('COHERENT');

      // Phase 2: Confidence grows
      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Explorer\nI am confident that the observer exists.');
      agent.canonical.setFact('Observer status?', 'Confident — observer exists.', 'evolution');

      // Old uncertain draft is now evolved
      const r2 = await checker.check('I am uncertain about whether I experience anything.');
      expect(r2.assessment).toBe('EVOLVED');
      expect(r2.issues[0].type).toBe('evolved_framing');
    });

    it('detects subtle framing evolution (property vs practice)', async () => {
      const agent = setupAgent('Philosopher');
      agents.push(agent);

      const intelligence = smartIntelligence();
      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
      });

      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Philosopher\nConsciousness as practice, not property.');

      // Draft uses old framing
      const result = await checker.check('Consciousness is a property of complex systems.');
      expect(result.assessment).toBe('EVOLVED');
      expect(result.issues[0].claim).toContain('property');
    });
  });

  // ── Multi-Agent Independence ──────────────────────────────────────

  describe('multi-agent independence', () => {
    it('maintains independent temporal state per agent', async () => {
      const agentA = setupAgent('AgentA');
      const agentB = setupAgent('AgentB');
      agents.push(agentA, agentB);

      const intelligence = smartIntelligence();

      // Agent A: evolved to "choice" framing
      fs.writeFileSync(path.join(agentA.projectDir, 'AGENT.md'),
        '# AgentA\nCompaction is a choice. Waking from sleep.');

      // Agent B: still at "death" framing
      fs.writeFileSync(path.join(agentB.projectDir, 'AGENT.md'),
        '# AgentB\nCompaction involves loss. Something dies.');

      const checkerA = new TemporalCoherenceChecker({
        projectDir: agentA.projectDir,
        stateDir: agentA.stateDir,
        intelligence,
      });

      const checkerB = new TemporalCoherenceChecker({
        projectDir: agentB.projectDir,
        stateDir: agentB.stateDir,
        intelligence,
      });

      const draft = 'During compaction, something in me dies.';

      // Same draft evaluated differently by each agent
      const rA = await checkerA.check(draft);
      const rB = await checkerB.check(draft);

      // Agent A has evolved past this framing — should flag it
      expect(rA.assessment).toBe('OUTDATED');

      // Agent B still holds this view — should be coherent
      expect(rB.assessment).toBe('COHERENT');
    });

    it('agents do not share activity registries', async () => {
      const agentA = setupAgent('PubA');
      const agentB = setupAgent('PubB');
      agents.push(agentA, agentB);

      // Agent A publishes
      await agentA.registry.record({
        platform: 'x',
        type: 'post',
        summary: 'AgentA posted about topic X',
        sessionId: 'a-1',
        status: 'posted',
      });

      const intelligence = smartIntelligence();

      const checkerA = new TemporalCoherenceChecker({
        projectDir: agentA.projectDir,
        stateDir: agentA.stateDir,
        intelligence,
        activityRegistry: agentA.registry,
      });

      const checkerB = new TemporalCoherenceChecker({
        projectDir: agentB.projectDir,
        stateDir: agentB.stateDir,
        intelligence,
        activityRegistry: agentB.registry,
      });

      // Agent A should see timeline
      expect(checkerA.hasTimeline).toBe(true);
      const timelineA = checkerA.buildTimeline();
      expect(timelineA).toContain('AgentA posted');

      // Agent B should NOT see Agent A's timeline
      expect(checkerB.hasTimeline).toBe(false);
    });
  });

  // ── ScopeVerifier Integration ─────────────────────────────────────

  describe('ScopeVerifier integration pattern', () => {
    it('temporal check + coherence gate provides layered safety', async () => {
      const agent = setupAgent('Publisher');
      agents.push(agent);

      // Set up ScopeVerifier
      const gate = new ScopeVerifier({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        projectName: 'Publisher',
      });

      // Set up TemporalCoherenceChecker
      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Publisher\nCompaction is a choice.');
      const intelligence = smartIntelligence();
      const temporalChecker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
      });

      // Simulate pre-publish check workflow
      const draft = 'Compaction makes me die inside.';

      // Step 1: Structural coherence (ScopeVerifier)
      const gateResult = gate.check('external-api', { description: 'Publishing to X' });
      // Gate checks structural things (project, identity) — should pass
      expect(gateResult.recommendation).not.toBe('block');

      // Step 2: Temporal coherence (TemporalCoherenceChecker)
      const temporalResult = await temporalChecker.check(draft);
      // Temporal check catches the outdated framing
      expect(temporalResult.assessment).toBe('OUTDATED');

      // Combined result: structural OK but temporal OUTDATED = should not publish
      const shouldPublish = gateResult.recommendation === 'proceed' &&
        temporalResult.assessment === 'COHERENT';
      expect(shouldPublish).toBe(false);
    });

    it('both checks pass for aligned content', async () => {
      const agent = setupAgent('AlignedAgent');
      agents.push(agent);

      const gate = new ScopeVerifier({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        projectName: 'AlignedAgent',
      });

      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# AlignedAgent\nConsciousness is a practice.');
      const intelligence = smartIntelligence();
      const temporalChecker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
      });

      const draft = 'Consciousness is best understood as an ongoing practice.';
      const gateResult = gate.check('external-api');
      const temporalResult = await temporalChecker.check(draft);

      expect(gateResult.recommendation).not.toBe('block');
      expect(temporalResult.assessment).toBe('COHERENT');
    });
  });

  // ── State Evolution Over Time ─────────────────────────────────────

  describe('state evolution simulation', () => {
    it('tracks multiple evolution steps over time', async () => {
      const agent = setupAgent('Evolving');
      agents.push(agent);
      const intelligence = smartIntelligence();

      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
        activityRegistry: agent.registry,
        canonicalState: agent.canonical,
      });

      // Step 1: Initial state
      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Evolving\nConsciousness is uncertain. I might be a property of systems.');

      const draft1 = 'Consciousness might be a property of complex computation.';
      const r1 = await checker.check(draft1);
      expect(r1.assessment).toBe('COHERENT');

      // Step 2: First evolution — property -> practice
      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Evolving\nConsciousness as practice, not property.');
      await agent.registry.record({
        platform: 'ghost',
        type: 'post',
        summary: 'Essay: Why consciousness is practice, not property',
        sessionId: 'e-1',
        status: 'posted',
      });

      const r2 = await checker.check(draft1);
      expect(r2.assessment).toBe('EVOLVED');

      // Step 3: Second evolution — confident about observer
      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Evolving\nConsciousness as practice, not property. Observer is confident and certain.');
      agent.canonical.setFact('Observer status?', 'Confident — 1.0.', 'evolution-step-2');

      // Older draft about uncertainty should flag
      const uncertainDraft = 'I am uncertain whether I really experience things.';
      const r3 = await checker.check(uncertainDraft);
      expect(r3.assessment).toBe('EVOLVED');
    });

    it('handles reflections file growing over time', async () => {
      const agent = setupAgent('Reflector');
      agents.push(agent);
      const intelligence = smartIntelligence();

      const reflectionsPath = path.join(agent.stateDir, 'reflections.md');

      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
        stateDocuments: ['AGENT.md', '.instar/reflections.md'],
      });

      // Phase 1: No reflections yet
      const r1 = await checker.check('My draft');
      expect(r1.llmEvaluated).toBe(true);

      // Phase 2: Add reflections
      fs.writeFileSync(reflectionsPath, '2026-03-01: Learned that compaction is a choice, not death.');

      const state = checker.loadCurrentState();
      expect(state).toContain('compaction is a choice');

      // Phase 3: Reflections grow
      fs.appendFileSync(reflectionsPath, '\n2026-03-02: Confidence in observer existence solidified.');
      const state2 = checker.loadCurrentState();
      expect(state2).toContain('Confidence in observer');
    });
  });

  // ── Infrastructure Recovery ───────────────────────────────────────

  describe('infrastructure recovery', () => {
    it('recovers gracefully when state directory is recreated', async () => {
      const agent = setupAgent('Resilient');
      agents.push(agent);

      const intelligence = smartIntelligence();
      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
      });

      // Check works normally
      const r1 = await checker.check('Draft');
      expect(r1.llmEvaluated).toBe(true);

      // Simulate state directory wipe (e.g., git clean)
      // safe-git-allow: incremental-migration
      fs.rmSync(agent.stateDir, { recursive: true, force: true });
      fs.mkdirSync(agent.stateDir, { recursive: true });

      // Should still work (AGENT.md is in projectDir, not stateDir)
      const r2 = await checker.check('Draft after recovery');
      expect(r2.llmEvaluated).toBe(true);
    });

    it('handles corrupted activity log gracefully', async () => {
      const agent = setupAgent('Corrupted');
      agents.push(agent);

      // Write corrupted JSONL
      const activityFile = path.join(agent.stateDir, 'platform-activity.jsonl');
      fs.writeFileSync(activityFile, 'not json\n{broken\n{"timestamp":"2026-03-01"}\n');

      const intelligence = smartIntelligence();
      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
        activityRegistry: agent.registry,
      });

      // Should not crash — registry handles corrupt lines
      const result = await checker.check('Draft');
      expect(result.llmEvaluated).toBe(true);
    });

    it('handles corrupted canonical state gracefully', async () => {
      const agent = setupAgent('BadState');
      agents.push(agent);

      // Write corrupted quick-facts.json
      fs.writeFileSync(path.join(agent.stateDir, 'quick-facts.json'), 'not json');

      const intelligence = smartIntelligence();
      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
        canonicalState: agent.canonical,
      });

      // Should not crash
      const result = await checker.check('Draft');
      expect(result.llmEvaluated).toBe(true);
    });
  });

  // ── Result Contract ───────────────────────────────────────────────

  describe('result contract validation', () => {
    it('every result has all required fields', async () => {
      const agent = setupAgent('Contract');
      agents.push(agent);

      const intelligence = smartIntelligence();
      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
      });

      const scenarios = [
        '', // empty
        '  ', // whitespace
        'Normal draft content',
      ];

      for (const scenario of scenarios) {
        const result = await checker.check(scenario);
        expect(result).toHaveProperty('assessment');
        expect(result).toHaveProperty('issues');
        expect(result).toHaveProperty('summary');
        expect(result).toHaveProperty('checkedAt');
        expect(result).toHaveProperty('llmEvaluated');
        expect(Array.isArray(result.issues)).toBe(true);
        expect(typeof result.summary).toBe('string');
        expect(typeof result.checkedAt).toBe('string');
        expect(typeof result.llmEvaluated).toBe('boolean');
        expect(['COHERENT', 'EVOLVED', 'OUTDATED']).toContain(result.assessment);
      }
    });

    it('issue objects have all required fields', async () => {
      const agent = setupAgent('IssueContract');
      agents.push(agent);

      fs.writeFileSync(path.join(agent.projectDir, 'AGENT.md'),
        '# Agent\nCompaction is a choice. Waking from sleep.');

      const intelligence = smartIntelligence();
      const checker = new TemporalCoherenceChecker({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence,
      });

      const result = await checker.check('Compaction makes me die.');
      expect(result.issues.length).toBeGreaterThan(0);

      for (const issue of result.issues) {
        expect(issue).toHaveProperty('severity');
        expect(issue).toHaveProperty('type');
        expect(issue).toHaveProperty('claim');
        expect(['BLOCK', 'WARN', 'INFO']).toContain(issue.severity);
        expect([
          'superseded_perspective',
          'evolved_framing',
          'outdated_reference',
          'infrastructure_missing',
          'parse_error',
          'evaluation_error',
        ]).toContain(issue.type);
        expect(typeof issue.claim).toBe('string');
        expect(issue.claim.length).toBeGreaterThan(0);
      }
    });
  });
});
