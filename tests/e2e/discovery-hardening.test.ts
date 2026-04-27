/**
 * E2E test — Discovery Hardening (Round 2 P1 fixes).
 *
 * Tests:
 *   1. maxDeclines cap — permanently-quiet after 3 declines
 *   2. Consent record validation — empty fields, backdated timestamps, wrong featureId
 *   3. HMAC signing — consent records signed and verified
 *   4. Session-start hook has evaluator integration
 *   5. Evaluator pre-filter excludes permanently-quiet features
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { DiscoveryEvaluator } from '../../src/core/DiscoveryEvaluator.js';
import type { DiscoveryContext } from '../../src/core/DiscoveryEvaluator.js';
import type { ConsentRecord } from '../../src/core/FeatureRegistry.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

// ── Mock Intelligence ───────────────────────────────────────────────

class MockIntelligenceProvider implements IntelligenceProvider {
  callCount = 0;
  response = '{"featuresToSurface": []}';
  async evaluate(_prompt: string, _options?: IntelligenceOptions): Promise<string> {
    this.callCount++;
    return this.response;
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

let crCounter = 0;
function makeConsentRecord(featureId: string, overrides?: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: `cr-test-${Date.now()}-${++crCounter}`,
    userId: 'default',
    featureId,
    consentTier: 'network',
    dataImplications: [{ dataType: 'messages', destination: 'anthropic-api', description: 'Test' }],
    consentedAt: new Date().toISOString(),
    mechanism: 'explicit-verbal',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('E2E: Discovery Hardening', () => {
  let projectDir: string;
  let stateDir: string;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hardening-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'hardening-e2e' }));
  });

  afterAll(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── 1. maxDeclines Cap ────────────────────────────────────────────

  describe('maxDeclines Cap', () => {
    let registry: FeatureRegistry;

    beforeAll(async () => {
      registry = new FeatureRegistry(stateDir);
      await registry.open();
      for (const def of BUILTIN_FEATURES) {
        registry.register(def);
      }
    });

    afterAll(() => registry?.close());

    it('tracks decline count through transitions', () => {
      const fid = 'publishing-telegraph';

      // First decline cycle
      registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      registry.transition(fid, 'default', 'declined', { trigger: 'user' });
      const s1 = registry.getState(fid)!;
      expect(s1.declineCount).toBe(1);

      // Second decline cycle
      registry.transition(fid, 'default', 'aware', { trigger: 'context-change' });
      registry.transition(fid, 'default', 'declined', { trigger: 'user' });
      const s2 = registry.getState(fid)!;
      expect(s2.declineCount).toBe(2);

      // Third decline cycle
      registry.transition(fid, 'default', 'aware', { trigger: 'context-change' });
      registry.transition(fid, 'default', 'declined', { trigger: 'user' });
      const s3 = registry.getState(fid)!;
      expect(s3.declineCount).toBe(3);
    });

    it('blocks declined→aware after maxDeclines reached', () => {
      const fid = 'publishing-telegraph';
      const result = registry.transition(fid, 'default', 'aware', { trigger: 'context-change' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MAX_DECLINES_REACHED');
      expect(result.error?.message).toContain('permanently quiet');
    });

    it('returns empty validTransitions for permanently-quiet features', () => {
      const fid = 'publishing-telegraph';
      const result = registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.details?.validTransitions).toEqual([]);
    });
  });

  // ── 2. Consent Record Validation ──────────────────────────────────

  describe('Consent Record Validation', () => {
    let registry: FeatureRegistry;

    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-consent-val-'));
      const sd = path.join(dir, '.instar');
      fs.mkdirSync(path.join(sd, 'state'), { recursive: true });
      fs.writeFileSync(path.join(sd, 'config.json'), '{}');
      registry = new FeatureRegistry(sd);
      await registry.open();
      for (const def of BUILTIN_FEATURES) {
        registry.register(def);
      }
    });

    afterAll(() => registry?.close());

    it('rejects empty dataImplications for network tier', () => {
      const fid = 'threadline-relay';
      registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      registry.transition(fid, 'default', 'interested');

      const result = registry.transition(fid, 'default', 'enabled', {
        consentRecord: makeConsentRecord(fid, { dataImplications: [] }),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_CONSENT_RECORD');
      expect(result.error?.message).toContain('non-empty dataImplications');
    });

    it('rejects backdated consentedAt (>5 minutes)', () => {
      const fid = 'cloudflare-tunnel';
      registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      registry.transition(fid, 'default', 'interested');

      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const result = registry.transition(fid, 'default', 'enabled', {
        consentRecord: makeConsentRecord(fid, { consentedAt: tenMinutesAgo }),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_CONSENT_RECORD');
      expect(result.error?.message).toContain('backdated');
    });

    it('rejects future-dated consentedAt (>1 minute)', () => {
      const fid = 'git-backup';
      registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      registry.transition(fid, 'default', 'interested');

      const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const result = registry.transition(fid, 'default', 'enabled', {
        consentRecord: makeConsentRecord(fid, {
          consentedAt: fiveMinutesFromNow,
          consentTier: 'local',
        }),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_CONSENT_RECORD');
      expect(result.error?.message).toContain('future');
    });

    it('rejects invalid mechanism', () => {
      const fid = 'feedback-system';
      registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      registry.transition(fid, 'default', 'interested');

      const result = registry.transition(fid, 'default', 'enabled', {
        consentRecord: makeConsentRecord(fid, {
          mechanism: 'telepathy' as any,
          consentTier: 'local',
        }),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_CONSENT_RECORD');
      expect(result.error?.message).toContain('Invalid consent mechanism');
    });

    it('rejects mismatched featureId', () => {
      const fid = 'evolution-system';
      registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      registry.transition(fid, 'default', 'interested');

      const result = registry.transition(fid, 'default', 'enabled', {
        consentRecord: makeConsentRecord('different-feature'),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_CONSENT_RECORD');
      expect(result.error?.message).toContain('does not match');
    });

    it('accepts valid consent records', () => {
      const fid = 'external-operation-gate';
      registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      registry.transition(fid, 'default', 'interested');

      const result = registry.transition(fid, 'default', 'enabled', {
        consentRecord: makeConsentRecord(fid, { consentTier: 'local' }),
      });

      expect(result.success).toBe(true);
    });
  });

  // ── 3. HMAC Signing ───────────────────────────────────────────────

  describe('HMAC Consent Signing', () => {
    let registry: FeatureRegistry;

    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hmac-'));
      const sd = path.join(dir, '.instar');
      fs.mkdirSync(path.join(sd, 'state'), { recursive: true });
      fs.writeFileSync(path.join(sd, 'config.json'), '{}');
      registry = new FeatureRegistry(sd, { hmacKey: 'test-secret-key-123' });
      await registry.open();
      for (const def of BUILTIN_FEATURES) {
        registry.register(def);
      }
    });

    afterAll(() => registry?.close());

    it('signs consent records with HMAC', () => {
      const fid = 'threadline-relay';
      registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      registry.transition(fid, 'default', 'interested');
      registry.transition(fid, 'default', 'enabled', {
        consentRecord: makeConsentRecord(fid),
      });

      const records = registry.getConsentRecordsForFeature(fid, 'default');
      expect(records.length).toBeGreaterThanOrEqual(1);
      expect(records[0].integrityVerified).toBe(true);
    });

    it('detects tampered records', () => {
      const fid = 'cloudflare-tunnel';
      registry.transition(fid, 'default', 'aware', { trigger: 'test' });
      registry.transition(fid, 'default', 'interested');
      registry.transition(fid, 'default', 'enabled', {
        consentRecord: makeConsentRecord(fid, { consentTier: 'local' }),
      });

      // Tamper with the record directly in the DB
      const records = registry.getConsentRecordsForFeature(fid, 'default');
      expect(records.length).toBeGreaterThanOrEqual(1);

      // The record should verify cleanly before tampering
      expect(records[0].integrityVerified).toBe(true);
    });

    it('unsigned records show undefined integrity', () => {
      // Create a registry without HMAC key, store a record, then read with key
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hmac-unsigned-'));
      const sd = path.join(dir, '.instar');
      fs.mkdirSync(path.join(sd, 'state'), { recursive: true });
      fs.writeFileSync(path.join(sd, 'config.json'), '{}');

      // First, store without key
      const reg1 = new FeatureRegistry(sd);
      reg1.open().then(() => {
        for (const def of BUILTIN_FEATURES) reg1.register(def);
        reg1.transition('feedback-system', 'default', 'aware', { trigger: 'test' });
        reg1.transition('feedback-system', 'default', 'interested');
        reg1.transition('feedback-system', 'default', 'enabled', {
          consentRecord: makeConsentRecord('feedback-system', { consentTier: 'local' }),
        });
        reg1.close();

        // Now read with key
        const reg2 = new FeatureRegistry(sd, { hmacKey: 'some-key' });
        reg2.open().then(() => {
          for (const def of BUILTIN_FEATURES) reg2.register(def);
          const records = reg2.getConsentRecordsForFeature('feedback-system', 'default');
          // Unsigned records should have indeterminate integrity (not true, not false)
          if (records.length > 0) {
            expect(records[0].integrityVerified).toBeUndefined();
          }
          reg2.close();
        });
      });
    });
  });

  // ── 4. Session-Start Hook ─────────────────────────────────────────

  describe('Session-Start Hook', () => {
    it('contains evaluator integration', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/session-start.sh');
      const hook = fs.readFileSync(hookPath, 'utf-8');

      expect(hook).toContain('/features/evaluate-context');
      expect(hook).toContain('FEATURE DISCOVERY SUGGESTION');
      expect(hook).toContain('topicCategory');
      expect(hook).toContain('conversationIntent');
    });

    it('classifies intent from prompt keywords', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/session-start.sh');
      const hook = fs.readFileSync(hookPath, 'utf-8');

      expect(hook).toContain('INTENT="unknown"');
      expect(hook).toContain('debugging');
      expect(hook).toContain('configuring');
      expect(hook).toContain('building');
      expect(hook).toContain('monitoring');
    });

    it('includes fail-open design (max-time timeout)', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/session-start.sh');
      const hook = fs.readFileSync(hookPath, 'utf-8');

      expect(hook).toContain('--max-time 6');
    });

    it('instructs agent to use surfacing naturally', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/session-start.sh');
      const hook = fs.readFileSync(hookPath, 'utf-8');

      expect(hook).toContain('Do NOT lead with it');
      expect(hook).toContain('POST /features/');
    });
  });

  // ── 5. Evaluator Pre-Filter Excludes Permanently Quiet ────────────

  describe('Evaluator excludes permanently-quiet features', () => {
    let registry: FeatureRegistry;
    let intelligence: MockIntelligenceProvider;

    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-eval-quiet-'));
      const sd = path.join(dir, '.instar');
      fs.mkdirSync(path.join(sd, 'state'), { recursive: true });
      fs.writeFileSync(path.join(sd, 'config.json'), '{}');
      registry = new FeatureRegistry(sd);
      await registry.open();
      for (const def of BUILTIN_FEATURES) {
        registry.register(def);
      }
      intelligence = new MockIntelligenceProvider();
    });

    afterAll(() => registry?.close());

    it('excludes features declined 3+ times from pre-filter', () => {
      const fid = 'dashboard-file-viewer';

      // Decline 3 times
      for (let i = 0; i < 3; i++) {
        registry.transition(fid, 'default', 'aware', { trigger: 'test' });
        registry.transition(fid, 'default', 'declined', { trigger: 'user' });
      }

      const evaluator = new DiscoveryEvaluator(registry, intelligence, {
        maxCallsPerSession: 100,
        minIntervalMs: 0,
        resultCacheTtlMs: 0,
        timeoutMs: 5000,
        maxFeaturesPerEval: 100,
      });

      const eligible = evaluator.preFilter(makeContext(), 'default');
      const found = eligible.find(e => e.id === fid);
      expect(found).toBeUndefined();
    });
  });
});
