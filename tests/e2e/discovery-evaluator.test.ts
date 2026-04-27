/**
 * E2E test — Discovery Evaluator (Consent & Discovery Framework, Phase 3).
 *
 * Tests the complete Phase 3 lifecycle:
 *   Input sanitization → Pre-filtering → LLM evaluation → Output validation →
 *   Rate limiting → Caching → Fail-open → API endpoints
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { DiscoveryEvaluator } from '../../src/core/DiscoveryEvaluator.js';
import type { DiscoveryContext, DiscoveryEvaluation, EligibleFeature } from '../../src/core/DiscoveryEvaluator.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig } from '../../src/core/types.js';

// ── Mock Intelligence Provider ──────────────────────────────────────

class MockIntelligenceProvider implements IntelligenceProvider {
  lastPrompt = '';
  callCount = 0;
  response: string | (() => string) = '{"featuresToSurface": []}';
  shouldThrow = false;
  throwError: Error | null = null;
  delay = 0;

  async evaluate(prompt: string, _options?: IntelligenceOptions): Promise<string> {
    this.lastPrompt = prompt;
    this.callCount++;

    if (this.shouldThrow) {
      throw this.throwError || new Error('Mock LLM error');
    }

    if (this.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delay));
    }

    return typeof this.response === 'function' ? this.response() : this.response;
  }

  reset(): void {
    this.lastPrompt = '';
    this.callCount = 0;
    this.response = '{"featuresToSurface": []}';
    this.shouldThrow = false;
    this.throwError = null;
    this.delay = 0;
  }
}

// ── Test Context ────────────────────────────────────────────────────

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

describe('E2E: Discovery Evaluator', () => {
  let projectDir: string;
  let stateDir: string;
  let registry: FeatureRegistry;
  let intelligence: MockIntelligenceProvider;
  let evaluator: DiscoveryEvaluator;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-evaluator-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'eval-e2e' }));

    registry = new FeatureRegistry(stateDir);
    await registry.open();
    for (const def of BUILTIN_FEATURES) {
      registry.register(def);
    }
    // Don't bootstrap — start from undiscovered state

    intelligence = new MockIntelligenceProvider();
  });

  beforeEach(() => {
    intelligence.reset();
    // Create fresh evaluator for each test with generous limits for testing
    evaluator = new DiscoveryEvaluator(registry, intelligence, {
      maxCallsPerSession: 100,
      minIntervalMs: 0,
      resultCacheTtlMs: 60_000,
      timeoutMs: 5_000,
      maxFeaturesPerEval: 10,
    });
  });

  afterAll(() => {
    registry?.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Pre-Filtering ────────────────────────────────────────────────

  describe('Pre-Filtering', () => {
    it('returns eligible features excluding enabled/disabled states', () => {
      const eligible = evaluator.preFilter(makeContext(), 'default');
      // All builtin features start as undiscovered → all eligible
      expect(eligible.length).toBeGreaterThan(0);

      // Enable one feature and check it's excluded
      registry.transition('threadline-relay', 'default', 'aware', { trigger: 'test' });
      registry.transition('threadline-relay', 'default', 'interested');
      registry.transition('threadline-relay', 'default', 'enabled', {
        consentRecord: {
          id: 'test-consent-1',
          userId: 'default',
          featureId: 'threadline-relay',
          consentTier: 'network',
          dataImplications: [],
          consentedAt: new Date().toISOString(),
          mechanism: 'explicit-verbal',
        },
      });
      const afterEnable = evaluator.preFilter(makeContext(), 'default');
      const enabledFeature = afterEnable.find(f => f.id === 'threadline-relay');
      expect(enabledFeature).toBeUndefined();
    });

    it('respects maxFeaturesPerEval cap', () => {
      const smallEvaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 0,
        resultCacheTtlMs: 60_000,
        timeoutMs: 5_000,
        maxFeaturesPerEval: 3,
      });
      const eligible = smallEvaluator.preFilter(makeContext(), 'default');
      expect(eligible.length).toBeLessThanOrEqual(3);
    });

    it('prioritizes undiscovered over aware features', () => {
      // Move one feature to aware
      registry.transition('publishing-telegraph', 'default', 'aware', { trigger: 'test' });
      const eligible = evaluator.preFilter(makeContext(), 'default');

      // Find positions
      const undiscovered = eligible.filter(f => {
        const state = registry.getState(f.id, 'default');
        return !state || state.discoveryState === 'undiscovered';
      });
      const aware = eligible.filter(f => {
        const state = registry.getState(f.id, 'default');
        return state?.discoveryState === 'aware';
      });

      // Undiscovered should come first
      if (undiscovered.length > 0 && aware.length > 0) {
        const firstUndiscoveredIdx = eligible.findIndex(f => f.id === undiscovered[0].id);
        const firstAwareIdx = eligible.findIndex(f => f.id === aware[0].id);
        expect(firstUndiscoveredIdx).toBeLessThan(firstAwareIdx);
      }
    });

    it('excludes features that exceeded maxSurfacesBeforeQuiet', () => {
      // Surface a feature many times
      const featureId = 'dashboard-file-viewer';
      registry.transition(featureId, 'default', 'aware', { trigger: 'test' });

      // Surface it more times than any trigger allows
      for (let i = 0; i < 10; i++) {
        registry.recordSurface(featureId, 'default', { surfacedAs: 'awareness' });
      }

      const eligible = evaluator.preFilter(makeContext(), 'default');
      const found = eligible.find(f => f.id === featureId);
      expect(found).toBeUndefined();
    });

    it('returns EligibleFeature shape with correct fields', () => {
      const eligible = evaluator.preFilter(makeContext(), 'default');
      if (eligible.length > 0) {
        const feat = eligible[0];
        expect(feat).toHaveProperty('id');
        expect(feat).toHaveProperty('name');
        expect(feat).toHaveProperty('category');
        expect(feat).toHaveProperty('oneLiner');
        expect(feat).toHaveProperty('consentTier');
        expect(feat).toHaveProperty('triggerConditions');
        expect(Array.isArray(feat.triggerConditions)).toBe(true);
      }
    });
  });

  // ── Prompt Building ──────────────────────────────────────────────

  describe('Prompt Building', () => {
    it('includes structural delimiters', () => {
      const eligible = evaluator.preFilter(makeContext(), 'default');
      const prompt = evaluator.buildPrompt(makeContext(), eligible);

      expect(prompt).toContain('<system>');
      expect(prompt).toContain('</system>');
      expect(prompt).toContain('<context>');
      expect(prompt).toContain('</context>');
      expect(prompt).toContain('<eligible_features>');
      expect(prompt).toContain('</eligible_features>');
    });

    it('includes topic category and intent but no raw user text', () => {
      const ctx = makeContext({ topicCategory: 'job-scheduling', conversationIntent: 'configuring' });
      const eligible = evaluator.preFilter(ctx, 'default');
      const prompt = evaluator.buildPrompt(ctx, eligible);

      expect(prompt).toContain('Topic: job-scheduling');
      expect(prompt).toContain('Intent: configuring');
    });

    it('includes problem categories as structured labels', () => {
      const ctx = makeContext({ problemCategories: ['high-skip-rate', 'session-stall'] });
      const eligible = evaluator.preFilter(ctx, 'default');
      const prompt = evaluator.buildPrompt(ctx, eligible);

      expect(prompt).toContain('high-skip-rate, session-stall');
    });

    it('includes eligible feature details', () => {
      const eligible: EligibleFeature[] = [{
        id: 'test-feature',
        name: 'Test Feature',
        category: 'safety',
        oneLiner: 'A test feature for unit tests',
        consentTier: 'local',
        triggerConditions: ['user asks about testing'],
      }];
      const prompt = evaluator.buildPrompt(makeContext(), eligible);

      expect(prompt).toContain('test-feature');
      expect(prompt).toContain('A test feature for unit tests');
      expect(prompt).toContain('user asks about testing');
    });

    it('requests JSON-only response with defined schema', () => {
      const prompt = evaluator.buildPrompt(makeContext(), []);
      expect(prompt).toContain('featuresToSurface');
      expect(prompt).toContain('featureId');
      expect(prompt).toContain('surfaceAs');
      expect(prompt).toContain('JSON only');
    });
  });

  // ── Output Validation ────────────────────────────────────────────

  describe('Output Validation', () => {
    const eligible: EligibleFeature[] = [
      {
        id: 'evolution-system',
        name: 'Evolution System',
        category: 'intelligence',
        oneLiner: 'Self-improvement through proposals',
        consentTier: 'local',
        triggerConditions: ['agent discusses improvements'],
      },
      {
        id: 'external-operation-gate',
        name: 'External Operation Safety',
        category: 'safety',
        oneLiner: 'Safety gates for external operations',
        consentTier: 'self-governing',
        triggerConditions: ['agent accesses external services'],
      },
    ];

    it('accepts valid recommendation with matching featureId', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'evolution-system',
          surfaceAs: 'awareness',
          reasoning: 'User is discussing improvements',
          messageForAgent: 'I have a feature that could help with self-improvement.',
        }],
      });

      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result).not.toBeNull();
      expect(result!.featureId).toBe('evolution-system');
      expect(result!.surfaceAs).toBe('awareness');
    });

    it('rejects featureId not in eligible set', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'nonexistent-feature',
          surfaceAs: 'awareness',
          reasoning: 'test',
          messageForAgent: 'test',
        }],
      });

      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result).toBeNull();
    });

    it('caps surfaceAs by autonomy profile', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'evolution-system',
          surfaceAs: 'prompt',
          reasoning: 'test',
          messageForAgent: 'test',
        }],
      });

      // Cautious profile caps at 'awareness'
      const result = evaluator.validateOutput(response, eligible, 'cautious');
      expect(result).not.toBeNull();
      expect(result!.surfaceAs).toBe('awareness');
    });

    it('blocks prompt for self-governing tier', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'external-operation-gate',
          surfaceAs: 'prompt',
          reasoning: 'test',
          messageForAgent: 'test',
        }],
      });

      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result).toBeNull();
    });

    it('returns null for empty featuresToSurface', () => {
      const response = JSON.stringify({ featuresToSurface: [] });
      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      const result = evaluator.validateOutput('not json at all', eligible, 'collaborative');
      expect(result).toBeNull();
    });

    it('extracts JSON from markdown code blocks', () => {
      const response = '```json\n{"featuresToSurface": [{"featureId": "evolution-system", "surfaceAs": "awareness", "reasoning": "test", "messageForAgent": "test message"}]}\n```';
      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result).not.toBeNull();
      expect(result!.featureId).toBe('evolution-system');
    });

    it('takes only the first recommendation', () => {
      const response = JSON.stringify({
        featuresToSurface: [
          { featureId: 'evolution-system', surfaceAs: 'awareness', reasoning: 'first', messageForAgent: 'first msg' },
          { featureId: 'external-operation-gate', surfaceAs: 'suggestion', reasoning: 'second', messageForAgent: 'second msg' },
        ],
      });

      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result).not.toBeNull();
      expect(result!.featureId).toBe('evolution-system');
    });

    it('rejects invalid surfaceAs values', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'evolution-system',
          surfaceAs: 'force',
          reasoning: 'test',
          messageForAgent: 'test',
        }],
      });

      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result).toBeNull();
    });

    it('rejects missing reasoning field', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'evolution-system',
          surfaceAs: 'awareness',
          messageForAgent: 'test',
        }],
      });

      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result).toBeNull();
    });

    it('rejects missing messageForAgent field', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'evolution-system',
          surfaceAs: 'awareness',
          reasoning: 'test',
        }],
      });

      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result).toBeNull();
    });
  });

  // ── Full Evaluation Flow ────────────────────────────────────────

  describe('Full Evaluation', () => {
    it('returns recommendation when LLM finds a match', async () => {
      intelligence.response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'evolution-system',
          surfaceAs: 'awareness',
          reasoning: 'User is exploring self-improvement',
          messageForAgent: 'I have a built-in evolution system that can help.',
        }],
      });

      const result = await evaluator.evaluate(makeContext({ topicCategory: 'self-improvement' }));
      expect(result.recommendation).not.toBeNull();
      expect(result.recommendation!.featureId).toBe('evolution-system');
      expect(result.cached).toBe(false);
      expect(result.rateLimited).toBe(false);
    });

    it('returns null recommendation when LLM finds no match', async () => {
      intelligence.response = '{"featuresToSurface": []}';

      const result = await evaluator.evaluate(makeContext());
      expect(result.recommendation).toBeNull();
      expect(result.eligibleCount).toBeGreaterThan(0);
    });

    it('caches results by topic category', async () => {
      intelligence.response = '{"featuresToSurface": []}';

      const result1 = await evaluator.evaluate(makeContext({ topicCategory: 'caching-test' }));
      expect(result1.cached).toBe(false);
      expect(intelligence.callCount).toBe(1);

      // Same topic → cached
      const result2 = await evaluator.evaluate(makeContext({ topicCategory: 'caching-test' }));
      expect(result2.cached).toBe(true);
      expect(intelligence.callCount).toBe(1); // No additional LLM call

      // Different topic → not cached
      const result3 = await evaluator.evaluate(makeContext({ topicCategory: 'different-topic' }));
      expect(result3.cached).toBe(false);
      expect(intelligence.callCount).toBe(2);
    });

    it('fails open on LLM errors', async () => {
      intelligence.shouldThrow = true;
      intelligence.throwError = new Error('API unavailable');

      const result = await evaluator.evaluate(makeContext());
      expect(result.recommendation).toBeNull();
      expect(result.error).toContain('API unavailable');
    });

    it('includes eligible count in result', async () => {
      intelligence.response = '{"featuresToSurface": []}';

      const result = await evaluator.evaluate(makeContext());
      expect(result.eligibleCount).toBeGreaterThan(0);
    });
  });

  // ── Rate Limiting ────────────────────────────────────────────────

  describe('Rate Limiting', () => {
    it('enforces maxCallsPerSession', async () => {
      const limitedEvaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 2,
        minIntervalMs: 0,
        resultCacheTtlMs: 0, // Disable cache for this test
        timeoutMs: 5_000,
        maxFeaturesPerEval: 10,
      });

      intelligence.response = '{"featuresToSurface": []}';

      // First two calls go through
      await limitedEvaluator.evaluate(makeContext({ topicCategory: 'rate-1' }));
      await limitedEvaluator.evaluate(makeContext({ topicCategory: 'rate-2' }));

      // Third call is rate-limited
      const result = await limitedEvaluator.evaluate(makeContext({ topicCategory: 'rate-3' }));
      expect(result.rateLimited).toBe(true);
      expect(result.recommendation).toBeNull();
    });

    it('enforces minIntervalMs', async () => {
      const intervalEvaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 60_000, // 1 minute minimum
        resultCacheTtlMs: 0,
        timeoutMs: 5_000,
        maxFeaturesPerEval: 10,
      });

      intelligence.response = '{"featuresToSurface": []}';

      await intervalEvaluator.evaluate(makeContext({ topicCategory: 'interval-1' }));

      // Second call within interval is rate-limited
      const result = await intervalEvaluator.evaluate(makeContext({ topicCategory: 'interval-2' }));
      expect(result.rateLimited).toBe(true);
    });

    it('resetSession clears rate limits', async () => {
      const limitedEvaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 1,
        minIntervalMs: 0,
        resultCacheTtlMs: 0,
        timeoutMs: 5_000,
        maxFeaturesPerEval: 10,
      });

      intelligence.response = '{"featuresToSurface": []}';

      await limitedEvaluator.evaluate(makeContext({ topicCategory: 'reset-1' }));
      const limited = await limitedEvaluator.evaluate(makeContext({ topicCategory: 'reset-2' }));
      expect(limited.rateLimited).toBe(true);

      limitedEvaluator.resetSession();
      const afterReset = await limitedEvaluator.evaluate(makeContext({ topicCategory: 'reset-3' }));
      expect(afterReset.rateLimited).toBe(false);
    });
  });

  // ── Cache Management ─────────────────────────────────────────────

  describe('Cache Management', () => {
    it('cache expires after TTL', async () => {
      const shortCacheEvaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 0,
        resultCacheTtlMs: 50, // 50ms TTL
        timeoutMs: 5_000,
        maxFeaturesPerEval: 10,
      });

      intelligence.response = '{"featuresToSurface": []}';

      await shortCacheEvaluator.evaluate(makeContext({ topicCategory: 'ttl-test' }));
      expect(intelligence.callCount).toBe(1);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      await shortCacheEvaluator.evaluate(makeContext({ topicCategory: 'ttl-test' }));
      expect(intelligence.callCount).toBe(2); // New LLM call after cache expiry
    });

    it('clearCache forces re-evaluation', async () => {
      intelligence.response = '{"featuresToSurface": []}';

      await evaluator.evaluate(makeContext({ topicCategory: 'clear-test' }));
      expect(intelligence.callCount).toBe(1);

      evaluator.clearCache();

      await evaluator.evaluate(makeContext({ topicCategory: 'clear-test' }));
      expect(intelligence.callCount).toBe(2);
    });
  });

  // ── Status Monitoring ────────────────────────────────────────────

  describe('Status', () => {
    it('reports current evaluator status', async () => {
      intelligence.response = '{"featuresToSurface": []}';

      const before = evaluator.getStatus();
      expect(before.callsThisSession).toBe(0);
      expect(before.cacheSize).toBe(0);

      await evaluator.evaluate(makeContext({ topicCategory: 'status-test' }));

      const after = evaluator.getStatus();
      expect(after.callsThisSession).toBe(1);
      expect(after.cacheSize).toBe(1);
      expect(after.lastCallTime).toBeGreaterThan(0);
    });
  });

  // ── Fail-Open Behavior ───────────────────────────────────────────

  describe('Fail-Open', () => {
    it('returns empty recommendation on timeout', async () => {
      const timeoutEvaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 0,
        resultCacheTtlMs: 0,
        timeoutMs: 50, // Very short timeout
        maxFeaturesPerEval: 10,
      });

      intelligence.delay = 200; // Longer than timeout
      intelligence.response = '{"featuresToSurface": []}';

      const result = await timeoutEvaluator.evaluate(makeContext({ topicCategory: 'timeout-test' }));
      expect(result.recommendation).toBeNull();
      expect(result.error).toContain('timeout');
    });

    it('returns empty recommendation on malformed LLM response', async () => {
      intelligence.response = 'This is not JSON at all, just random text from the LLM';

      const result = await evaluator.evaluate(makeContext({ topicCategory: 'malformed-test' }));
      expect(result.recommendation).toBeNull();
      // No error field — malformed response is handled gracefully
    });
  });

  // ── Empty Eligible Set ───────────────────────────────────────────

  describe('No Eligible Features', () => {
    it('skips LLM call when no features are eligible', async () => {
      // Create evaluator with a fresh registry that has no features
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-eval-empty-'));
      const emptyStateDir = path.join(emptyDir, '.instar');
      fs.mkdirSync(emptyStateDir, { recursive: true });

      const emptyRegistry = new FeatureRegistry(emptyStateDir);
      await emptyRegistry.open();

      const emptyEvaluator = new DiscoveryEvaluator(emptyRegistry, intelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 0,
        resultCacheTtlMs: 60_000,
        timeoutMs: 5_000,
        maxFeaturesPerEval: 10,
      });

      const result = await emptyEvaluator.evaluate(makeContext());
      expect(result.recommendation).toBeNull();
      expect(result.eligibleCount).toBe(0);
      expect(intelligence.callCount).toBe(0); // No LLM call

      emptyRegistry.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  // ── API Endpoints ────────────────────────────────────────────────

  describe('API Endpoints', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const config: InstarConfig = {
        projectDir,
        stateDir,
        projectName: 'eval-api-e2e',
        agentName: 'test-agent',
        port: 0,
        sessions: { maxConcurrent: 2, defaultModel: 'sonnet' },
        scheduler: { enabled: false },
        users: [],
        messaging: [],
        monitoring: { healthCheck: { enabled: false } },
      } as InstarConfig;

      const state = new StateManager(stateDir);

      // Create evaluator with mock intelligence
      const apiIntelligence = new MockIntelligenceProvider();
      apiIntelligence.response = '{"featuresToSurface": []}';

      const apiEvaluator = new DiscoveryEvaluator(registry, apiIntelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 0,
        resultCacheTtlMs: 0,
        timeoutMs: 5_000,
        maxFeaturesPerEval: 10,
      });

      const app = express();
      app.use(express.json());

      const router = createRoutes({
        config,
        state,
        sessionManager: null as any,
        scheduler: null,
        telegram: null,
        relationships: null,
        feedback: null,
        dispatches: null,
        updateChecker: null,
        autoUpdater: null,
        autoDispatcher: null,
        quotaTracker: null,
        publisher: null,
        viewer: null,
        tunnel: null,
        evolution: null,
        watchdog: null,
        triageNurse: null,
        topicMemory: null,
        feedbackAnomalyDetector: null,
        projectMapper: null,
        coherenceGate: null,
        contextHierarchy: null,
        canonicalState: null,
        operationGate: null,
        sentinel: null,
        adaptiveTrust: null,
        memoryMonitor: null,
        orphanReaper: null,
        coherenceMonitor: null,
        commitmentTracker: null,
        semanticMemory: null,
        activitySentinel: null,
        messageRouter: null,
        summarySentinel: null,
        spawnManager: null,
        workingMemory: null,
        quotaManager: null,
        systemReviewer: null,
        capabilityMapper: null,
        selfKnowledgeTree: null,
        coverageAuditor: null,
        topicResumeMap: null,
        autonomyManager: null,
        trustElevationTracker: null,
        autonomousEvolution: null,
        whatsapp: null,
        messageBridge: null,
        hookEventReceiver: null,
        worktreeMonitor: null,
        subagentTracker: null,
        instructionsVerifier: null,
        threadlineRouter: null,
        handshakeManager: null,
        threadlineRelayClient: null,
        listenerManager: null,
        responseReviewGate: null,
        telemetryHeartbeat: null,
        pasteManager: null,
        wsManager: null,
        soulManager: null,
        featureRegistry: registry,
        discoveryEvaluator: apiEvaluator,
        startTime: new Date(),
      });

      app.use(router);

      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('POST /features/evaluate-context returns evaluation', async () => {
      const res = await fetch(`${baseUrl}/features/evaluate-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicCategory: 'api-test',
          conversationIntent: 'exploring',
          problemCategories: [],
          autonomyProfile: 'collaborative',
          enabledFeatures: [],
        }),
      });

      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body).toHaveProperty('recommendation');
      expect(body).toHaveProperty('cached');
      expect(body).toHaveProperty('rateLimited');
      expect(body).toHaveProperty('eligibleCount');
    });

    it('POST /features/evaluate-context rejects missing topicCategory', async () => {
      const res = await fetch(`${baseUrl}/features/evaluate-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationIntent: 'exploring',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('MISSING_TOPIC');
    });

    it('POST /features/evaluate-context defaults missing optional fields', async () => {
      const res = await fetch(`${baseUrl}/features/evaluate-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicCategory: 'defaults-test',
        }),
      });

      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body).toHaveProperty('recommendation');
    });

    it('GET /features/evaluator-status returns status', async () => {
      const res = await fetch(`${baseUrl}/features/evaluator-status`);
      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body).toHaveProperty('callsThisSession');
      expect(body).toHaveProperty('maxCallsPerSession');
      expect(body).toHaveProperty('cacheSize');
    });
  });

  // ── Autonomy Profile Caps ────────────────────────────────────────

  describe('Autonomy Profile Caps', () => {
    const eligible: EligibleFeature[] = [{
      id: 'evolution-system',
      name: 'Evolution System',
      category: 'intelligence',
      oneLiner: 'Self-improvement',
      consentTier: 'local',
      triggerConditions: [],
    }];

    it('cautious caps at awareness', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'evolution-system',
          surfaceAs: 'suggestion',
          reasoning: 'test',
          messageForAgent: 'test',
        }],
      });

      const result = evaluator.validateOutput(response, eligible, 'cautious');
      expect(result!.surfaceAs).toBe('awareness');
    });

    it('supervised caps at suggestion', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'evolution-system',
          surfaceAs: 'prompt',
          reasoning: 'test',
          messageForAgent: 'test',
        }],
      });

      const result = evaluator.validateOutput(response, eligible, 'supervised');
      expect(result!.surfaceAs).toBe('suggestion');
    });

    it('collaborative allows prompt', () => {
      const response = JSON.stringify({
        featuresToSurface: [{
          featureId: 'evolution-system',
          surfaceAs: 'prompt',
          reasoning: 'test',
          messageForAgent: 'test',
        }],
      });

      const result = evaluator.validateOutput(response, eligible, 'collaborative');
      expect(result!.surfaceAs).toBe('prompt');
    });
  });
});
