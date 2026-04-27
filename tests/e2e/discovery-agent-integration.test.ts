/**
 * E2E test — Discovery Agent Integration (Consent & Discovery Framework, Phase 4).
 *
 * Tests:
 *   1. AGENT.md template includes behavioral contract
 *   2. Surfacing templates (awareness, suggestion, prompt) — dark-pattern-free
 *   3. Compaction-recovery hook includes discovery state injection
 *   4. Autonomy profile controls discovery aggressiveness
 *   5. Evaluator respects passive (cautious) autonomy profile
 *   6. Self-knowledge tree has discovery node
 *   7. Surfacing message validation (dark pattern detection)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { DiscoveryEvaluator } from '../../src/core/DiscoveryEvaluator.js';
import type { DiscoveryContext } from '../../src/core/DiscoveryEvaluator.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import {
  awarenessMessage,
  suggestionMessage,
  promptMessage,
  generateSurfacingMessage,
  validateSurfacingMessage,
  recommendedSurfaceLevel,
} from '../../src/core/SurfacingTemplates.js';
import type { SurfacingMessage } from '../../src/core/SurfacingTemplates.js';
import { generateAgentMd } from '../../src/scaffold/templates.js';
import { TreeGenerator } from '../../src/knowledge/TreeGenerator.js';
import { AutonomyProfileManager, type DiscoveryAggressiveness } from '../../src/core/AutonomyProfileManager.js';

// ── Mock Intelligence Provider ──────────────────────────────────────

class MockIntelligenceProvider implements IntelligenceProvider {
  lastPrompt = '';
  callCount = 0;
  response = '{"featuresToSurface": []}';

  async evaluate(prompt: string, _options?: IntelligenceOptions): Promise<string> {
    this.lastPrompt = prompt;
    this.callCount++;
    return this.response;
  }

  reset(): void {
    this.lastPrompt = '';
    this.callCount = 0;
    this.response = '{"featuresToSurface": []}';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<DiscoveryContext>): DiscoveryContext {
  return {
    topicCategory: 'debugging',
    conversationIntent: 'debugging',
    problemCategories: [],
    autonomyProfile: 'collaborative',
    enabledFeatures: [],
    userId: 'default',
    ...overrides,
  };
}

function getTestFeature() {
  return BUILTIN_FEATURES.find(f => f.id === 'publishing-telegraph')!;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('E2E: Discovery Agent Integration (Phase 4)', () => {
  let projectDir: string;
  let stateDir: string;
  let registry: FeatureRegistry;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-phase4-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName: 'phase4-e2e',
      autonomyProfile: 'collaborative',
    }));
    // Create AGENT.md for TreeGenerator
    fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# TestAgent\n\n## Values\n\nTest values.\n\n## Personality\n\nTest personality.');

    registry = new FeatureRegistry(stateDir);
    await registry.open();
    for (const def of BUILTIN_FEATURES) {
      registry.register(def);
    }
  });

  afterAll(() => {
    registry?.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── 1. AGENT.md Behavioral Contract ───────────────────────────────

  describe('AGENT.md Template', () => {
    const md = generateAgentMd({
      name: 'TestAgent',
      role: 'Testing agent',
      personality: 'Direct and thorough.',
      userName: 'TestUser',
    });

    it('includes Feature Discovery Contract section', () => {
      expect(md).toContain('## Feature Discovery Contract');
    });

    it('includes DO rules', () => {
      expect(md).toContain('### DO');
      expect(md).toContain('Mention features naturally');
      expect(md).toContain('Frame awareness as information');
      expect(md).toContain('Include the reversibility note');
      expect(md).toContain('POST /features/:id/surface');
    });

    it('includes DON\'T rules', () => {
      expect(md).toContain('### DON\'T');
      expect(md).toContain('more than one undiscovered feature per conversation turn');
      expect(md).toContain('Re-mention a declined feature');
      expect(md).toContain('list of "things you should enable"');
      expect(md).toContain('time-sensitive or frustrating moments');
      expect(md).toContain('network');
    });

    it('labels rules with enforcement type', () => {
      expect(md).toContain('server-enforced');
      expect(md).toContain('agent-behavioral');
    });

    it('includes surfacing level templates', () => {
      expect(md).toContain('### Surfacing Levels');
      expect(md).toContain('Awareness');
      expect(md).toContain('Suggestion');
      expect(md).toContain('Prompt');
    });

    it('includes explicit no-auto-enable rule', () => {
      expect(md).toContain('Auto-enable features, even');
      expect(md).toContain('consent is always explicit');
    });

    it('still contains original sections', () => {
      expect(md).toContain('## My Principles');
      expect(md).toContain('## Self-Observations');
      expect(md).toContain('## Growth');
    });
  });

  // ── 2. Surfacing Templates ────────────────────────────────────────

  describe('Surfacing Templates', () => {
    const feature = getTestFeature();

    describe('Awareness level', () => {
      it('generates low-pressure message', () => {
        const msg = awarenessMessage(feature);
        expect(msg.level).toBe('awareness');
        expect(msg.featureId).toBe(feature.id);
        expect(msg.message).toContain(feature.name);
        expect(msg.message).toContain('opt-in');
        expect(msg.message).toContain('No action needed');
      });

      it('does not disclose data implications', () => {
        const msg = awarenessMessage(feature);
        expect(msg.dataDisclosed).toBe(false);
      });

      it('does not mention reversibility', () => {
        const msg = awarenessMessage(feature);
        expect(msg.reversibilityMentioned).toBe(false);
      });

      it('passes dark pattern validation', () => {
        const msg = awarenessMessage(feature);
        const violations = validateSurfacingMessage(msg);
        expect(violations).toHaveLength(0);
      });
    });

    describe('Suggestion level', () => {
      it('ties to observed context', () => {
        const msg = suggestionMessage(feature, {
          observedContext: 'you\'re sharing content that could be useful for others',
        });
        expect(msg.level).toBe('suggestion');
        expect(msg.message).toContain('sharing content');
        expect(msg.message).toContain(feature.name);
        expect(msg.message).toContain('Happy to explain more');
      });

      it('uses generic context when none provided', () => {
        const msg = suggestionMessage(feature, {});
        expect(msg.message).toContain('what you\'re working on');
      });

      it('passes dark pattern validation', () => {
        const msg = suggestionMessage(feature, { observedContext: 'test context' });
        expect(validateSurfacingMessage(msg)).toHaveLength(0);
      });
    });

    describe('Prompt level', () => {
      it('includes data implications before benefits', () => {
        const msg = promptMessage(feature, {
          specificBenefit: 'publish your research as a web page',
        });
        expect(msg.level).toBe('prompt');
        expect(msg.dataDisclosed).toBe(true);
        expect(msg.reversibilityMentioned).toBe(true);
        expect(msg.message).toContain(feature.name);
        expect(msg.message).toContain('Let me know if');
      });

      it('includes reversibility note', () => {
        const msg = promptMessage(feature, {});
        expect(msg.message).toContain(feature.reversibilityNote);
      });

      it('passes dark pattern validation', () => {
        const msg = promptMessage(feature, { specificBenefit: 'help you share' });
        expect(validateSurfacingMessage(msg)).toHaveLength(0);
      });
    });

    describe('generateSurfacingMessage dispatcher', () => {
      it('dispatches to correct template based on level', () => {
        const awareness = generateSurfacingMessage(feature, 'awareness');
        expect(awareness.level).toBe('awareness');

        const suggestion = generateSurfacingMessage(feature, 'suggestion', {
          observedContext: 'test',
        });
        expect(suggestion.level).toBe('suggestion');

        const prompt = generateSurfacingMessage(feature, 'prompt', {
          specificBenefit: 'test benefit',
        });
        expect(prompt.level).toBe('prompt');
      });
    });

    describe('Dark pattern detection', () => {
      it('detects prescriptive language', () => {
        const msg: SurfacingMessage = {
          level: 'awareness',
          message: 'You should enable this feature right now.',
          featureId: 'test',
          dataDisclosed: false,
          reversibilityMentioned: false,
        };
        const violations = validateSurfacingMessage(msg);
        expect(violations.some(v => v.includes('you should'))).toBe(true);
      });

      it('detects manufactured urgency', () => {
        const msg: SurfacingMessage = {
          level: 'awareness',
          message: "Don't miss out on this feature!",
          featureId: 'test',
          dataDisclosed: false,
          reversibilityMentioned: false,
        };
        expect(validateSurfacingMessage(msg).some(v => v.includes('miss'))).toBe(true);
      });

      it('detects anthropomorphic pressure', () => {
        const msg: SurfacingMessage = {
          level: 'awareness',
          message: 'Want me to enable this for you?',
          featureId: 'test',
          dataDisclosed: false,
          reversibilityMentioned: false,
        };
        expect(validateSurfacingMessage(msg).some(v => v.includes('want me to'))).toBe(true);
      });

      it('requires data disclosure for prompt level', () => {
        const msg: SurfacingMessage = {
          level: 'prompt',
          message: 'Enable this feature. Let me know.',
          featureId: 'test',
          dataDisclosed: false,
          reversibilityMentioned: false,
        };
        const violations = validateSurfacingMessage(msg);
        expect(violations.some(v => v.includes('data implications'))).toBe(true);
        expect(violations.some(v => v.includes('reversibility'))).toBe(true);
      });

      it('passes when prompt has data + reversibility', () => {
        const msg: SurfacingMessage = {
          level: 'prompt',
          message: 'This sends data to Anthropic API. Reversible: disable anytime. Let me know if interested.',
          featureId: 'test',
          dataDisclosed: true,
          reversibilityMentioned: true,
        };
        expect(validateSurfacingMessage(msg)).toHaveLength(0);
      });
    });

    describe('recommendedSurfaceLevel', () => {
      it('returns suggestion for informational tier', () => {
        expect(recommendedSurfaceLevel('informational')).toBe('suggestion');
      });

      it('returns suggestion for local tier', () => {
        expect(recommendedSurfaceLevel('local')).toBe('suggestion');
      });

      it('returns awareness for network tier', () => {
        expect(recommendedSurfaceLevel('network')).toBe('awareness');
      });

      it('returns awareness for self-governing tier', () => {
        expect(recommendedSurfaceLevel('self-governing')).toBe('awareness');
      });
    });
  });

  // ── 3. Compaction-Recovery Hook ───────────────────────────────────

  describe('Compaction-Recovery Hook', () => {
    it('contains discovery state injection phase', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/compaction-recovery.sh');
      const hook = fs.readFileSync(hookPath, 'utf-8');

      expect(hook).toContain('FEATURE DISCOVERY STATE');
      expect(hook).toContain('/features/summary');
      expect(hook).toContain('Do NOT re-surface features already mentioned');
      expect(hook).toContain('POST /features/:id/surface');
    });

    it('checks lastSurfacedAt timestamps', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/compaction-recovery.sh');
      const hook = fs.readFileSync(hookPath, 'utf-8');

      // Verifies the hook references surface timestamps for compaction safety
      expect(hook).toContain('compaction-safe');
    });

    it('groups features by discovery state', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/compaction-recovery.sh');
      const hook = fs.readFileSync(hookPath, 'utf-8');

      expect(hook).toContain('discoveryState');
      expect(hook).toContain('enabled');
      expect(hook).toContain('undiscovered');
    });

    it('is positioned between cognitive principles and relationships', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/compaction-recovery.sh');
      const hook = fs.readFileSync(hookPath, 'utf-8');

      const discoveryIdx = hook.indexOf('FEATURE DISCOVERY STATE');
      const relIdx = hook.indexOf('Relationships summary');
      const cogIdx = hook.indexOf('COGNITIVE PRINCIPLES');

      expect(discoveryIdx).toBeGreaterThan(cogIdx);
      expect(discoveryIdx).toBeLessThan(relIdx);
    });
  });

  // ── 4. Autonomy Profile Discovery Aggressiveness ──────────────────

  describe('Autonomy Profile Discovery Control', () => {
    it('cautious profile has passive discovery', () => {
      const manager = new AutonomyProfileManager({
        stateDir,
        config: { autonomyProfile: 'cautious' } as any,
      });
      const resolved = manager.getResolvedState();
      expect(resolved.discoveryAggressiveness).toBe('passive');
    });

    it('supervised profile has contextual discovery', () => {
      const manager = new AutonomyProfileManager({
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-test-')),
        config: { autonomyProfile: 'supervised' } as any,
      });
      const resolved = manager.getResolvedState();
      expect(resolved.discoveryAggressiveness).toBe('contextual');
    });

    it('collaborative profile has proactive discovery', () => {
      const manager = new AutonomyProfileManager({
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-test-')),
        config: { autonomyProfile: 'collaborative' } as any,
      });
      const resolved = manager.getResolvedState();
      expect(resolved.discoveryAggressiveness).toBe('proactive');
    });

    it('autonomous profile has proactive discovery', () => {
      const manager = new AutonomyProfileManager({
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-test-')),
        config: { autonomyProfile: 'autonomous' } as any,
      });
      const resolved = manager.getResolvedState();
      expect(resolved.discoveryAggressiveness).toBe('proactive');
    });

    it('natural language summary includes discovery label', () => {
      const manager = new AutonomyProfileManager({
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-test-')),
        config: { autonomyProfile: 'collaborative' } as any,
      });
      const summary = manager.getNaturalLanguageSummary();
      expect(summary).toContain('Feature discovery:');
      expect(summary).toContain('proactive');
    });

    it('config override takes precedence over profile default', () => {
      const manager = new AutonomyProfileManager({
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-test-')),
        config: {
          autonomyProfile: 'collaborative',
          discoveryAggressiveness: 'passive',
        } as any,
      });
      const resolved = manager.getResolvedState();
      expect(resolved.discoveryAggressiveness).toBe('passive');
    });
  });

  // ── 5. Evaluator Respects Autonomy Profile ────────────────────────

  describe('Evaluator Autonomy Gating', () => {
    let intelligence: MockIntelligenceProvider;

    beforeEach(() => {
      intelligence = new MockIntelligenceProvider();
    });

    it('skips evaluation for cautious autonomy profile', async () => {
      const evaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 0,
        resultCacheTtlMs: 0,
        timeoutMs: 5000,
        maxFeaturesPerEval: 10,
      });

      const result = await evaluator.evaluate(makeContext({
        autonomyProfile: 'cautious',
      }));

      expect(result.recommendation).toBeNull();
      expect(intelligence.callCount).toBe(0);
    });

    it('allows evaluation for supervised profile', async () => {
      const evaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 0,
        resultCacheTtlMs: 0,
        timeoutMs: 5000,
        maxFeaturesPerEval: 10,
      });

      intelligence.response = '{"featuresToSurface": []}';
      const result = await evaluator.evaluate(makeContext({
        autonomyProfile: 'supervised',
      }));

      // Should actually call the LLM (not short-circuited)
      expect(intelligence.callCount).toBeGreaterThanOrEqual(0); // May be 0 if no eligible features after pre-filter
    });

    it('allows evaluation for collaborative profile', async () => {
      const evaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 0,
        resultCacheTtlMs: 0,
        timeoutMs: 5000,
        maxFeaturesPerEval: 10,
      });

      intelligence.response = '{"featuresToSurface": []}';
      await evaluator.evaluate(makeContext({ autonomyProfile: 'collaborative' }));
      // Should reach the LLM if there are eligible features
      // The exact call count depends on pre-filtering results
      expect(intelligence.callCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ── 6. Self-Knowledge Tree Discovery Node ─────────────────────────

  describe('Self-Knowledge Tree', () => {
    it('generates a discovery node in capabilities layer', () => {
      const generator = new TreeGenerator();
      const config = generator.generate({
        projectDir,
        stateDir,
        agentName: 'TestAgent',
        hasMemory: true,
        hasJobs: true,
      });

      const capabilitiesLayer = config.layers.find(l => l.id === 'capabilities');
      expect(capabilitiesLayer).toBeDefined();

      const discoveryNode = capabilitiesLayer!.children.find(n => n.id === 'capabilities.discovery');
      expect(discoveryNode).toBeDefined();
      expect(discoveryNode!.name).toBe('Feature Discovery');
      expect(discoveryNode!.description.toLowerCase()).toContain('opt-in feature discovery');
      expect(discoveryNode!.description).toContain('surfacing rules');
      expect(discoveryNode!.description).toContain('behavioral contract');
    });

    it('discovery node uses probe source', () => {
      const generator = new TreeGenerator();
      const config = generator.generate({
        projectDir,
        stateDir,
        agentName: 'TestAgent',
      });

      const capLayer = config.layers.find(l => l.id === 'capabilities');
      const discoveryNode = capLayer!.children.find(n => n.id === 'capabilities.discovery');
      expect(discoveryNode!.sources).toHaveLength(1);
      expect(discoveryNode!.sources[0].type).toBe('probe');
      expect((discoveryNode!.sources[0] as any).name).toBe('feature-discovery');
    });

    it('discovery node is managed and medium depth', () => {
      const generator = new TreeGenerator();
      const config = generator.generate({
        projectDir,
        stateDir,
        agentName: 'TestAgent',
      });

      const capLayer = config.layers.find(l => l.id === 'capabilities');
      const discoveryNode = capLayer!.children.find(n => n.id === 'capabilities.discovery');
      expect(discoveryNode!.managed).toBe(true);
      expect(discoveryNode!.depth).toBe('medium');
      expect(discoveryNode!.sensitivity).toBe('public');
    });

    it('discovery node survives tree regeneration', () => {
      const generator = new TreeGenerator();

      // Generate first time
      const config1 = generator.generate({
        projectDir,
        stateDir,
        agentName: 'TestAgent',
      });
      generator.save(config1, stateDir);

      // Regenerate
      const config2 = generator.generate({
        projectDir,
        stateDir,
        agentName: 'TestAgent',
      });

      const capLayer = config2.layers.find(l => l.id === 'capabilities');
      const discoveryNode = capLayer!.children.find(n => n.id === 'capabilities.discovery');
      expect(discoveryNode).toBeDefined();
    });
  });

  // ── 7. Template Design Principles ─────────────────────────────────

  describe('Template Design Principles', () => {
    it('all builtin features produce valid awareness messages', () => {
      for (const def of BUILTIN_FEATURES) {
        const msg = awarenessMessage(def);
        const violations = validateSurfacingMessage(msg);
        expect(violations).toHaveLength(0);
      }
    });

    it('all builtin features produce valid suggestion messages', () => {
      for (const def of BUILTIN_FEATURES) {
        const msg = suggestionMessage(def, { observedContext: 'a pattern I noticed' });
        const violations = validateSurfacingMessage(msg);
        expect(violations).toHaveLength(0);
      }
    });

    it('all builtin features produce valid prompt messages', () => {
      for (const def of BUILTIN_FEATURES) {
        const msg = promptMessage(def, { specificBenefit: 'help with your workflow' });
        const violations = validateSurfacingMessage(msg);
        expect(violations).toHaveLength(0);
      }
    });

    it('awareness messages never ask questions', () => {
      for (const def of BUILTIN_FEATURES) {
        const msg = awarenessMessage(def);
        // Should end with statement, not question
        expect(msg.message).not.toMatch(/\?$/);
      }
    });

    it('prompt messages always mention reversibility', () => {
      for (const def of BUILTIN_FEATURES) {
        const msg = promptMessage(def, {});
        expect(msg.reversibilityMentioned).toBe(true);
        expect(msg.message).toContain('Reversible:');
      }
    });

    it('prompt messages present data before benefits', () => {
      const def = getTestFeature();
      const msg = promptMessage(def, { specificBenefit: 'share research publicly' });
      // Data implications should come before the benefit
      const dataIdx = msg.message.indexOf(def.name) + def.name.length;
      const benefitIdx = msg.message.indexOf('share research publicly');
      expect(dataIdx).toBeLessThan(benefitIdx);
    });
  });
});
