import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ExternalOperationGate,
  computeRiskLevel,
  scopeFromCount,
  AUTONOMY_PROFILES,
} from '../../src/core/ExternalOperationGate.js';
import type {
  ExternalOperationGateConfig,
  OperationMutability,
  OperationReversibility,
  OperationScope,
  RiskLevel,
} from '../../src/core/ExternalOperationGate.js';

describe('computeRiskLevel', () => {
  it('reads are always low risk', () => {
    expect(computeRiskLevel('read', 'irreversible', 'bulk')).toBe('low');
    expect(computeRiskLevel('read', 'reversible', 'single')).toBe('low');
  });

  it('bulk irreversible operations are critical', () => {
    expect(computeRiskLevel('write', 'irreversible', 'bulk')).toBe('critical');
    expect(computeRiskLevel('modify', 'irreversible', 'bulk')).toBe('critical');
    expect(computeRiskLevel('delete', 'irreversible', 'bulk')).toBe('critical');
  });

  it('bulk deletes are always critical', () => {
    expect(computeRiskLevel('delete', 'reversible', 'bulk')).toBe('critical');
    expect(computeRiskLevel('delete', 'partially-reversible', 'bulk')).toBe('critical');
  });

  it('any bulk mutation is critical', () => {
    expect(computeRiskLevel('write', 'reversible', 'bulk')).toBe('critical');
    expect(computeRiskLevel('modify', 'reversible', 'bulk')).toBe('critical');
  });

  it('batch deletes are high risk', () => {
    expect(computeRiskLevel('delete', 'reversible', 'batch')).toBe('high');
    expect(computeRiskLevel('delete', 'partially-reversible', 'batch')).toBe('high');
  });

  it('batch irreversible writes are high risk', () => {
    expect(computeRiskLevel('write', 'irreversible', 'batch')).toBe('high');
  });

  it('single irreversible deletes are high risk', () => {
    expect(computeRiskLevel('delete', 'irreversible', 'single')).toBe('high');
  });

  it('single reversible deletes are medium risk', () => {
    expect(computeRiskLevel('delete', 'reversible', 'single')).toBe('medium');
  });

  it('single irreversible writes are medium risk', () => {
    expect(computeRiskLevel('write', 'irreversible', 'single')).toBe('medium');
  });

  it('batch reversible writes are medium risk', () => {
    expect(computeRiskLevel('write', 'reversible', 'batch')).toBe('medium');
  });

  it('single reversible writes are low risk', () => {
    expect(computeRiskLevel('write', 'reversible', 'single')).toBe('low');
  });

  it('single reversible modifies are low risk', () => {
    expect(computeRiskLevel('modify', 'reversible', 'single')).toBe('low');
  });
});

describe('scopeFromCount', () => {
  it('single item', () => {
    expect(scopeFromCount(1)).toBe('single');
    expect(scopeFromCount(0)).toBe('single');
  });

  it('batch items (2-20)', () => {
    expect(scopeFromCount(2)).toBe('batch');
    expect(scopeFromCount(10)).toBe('batch');
    expect(scopeFromCount(20)).toBe('batch');
  });

  it('bulk items (>20)', () => {
    expect(scopeFromCount(21)).toBe('bulk');
    expect(scopeFromCount(200)).toBe('bulk');
  });

  it('respects custom thresholds', () => {
    expect(scopeFromCount(3, { batchThreshold: 3, bulkThreshold: 10 })).toBe('batch');
    expect(scopeFromCount(11, { batchThreshold: 3, bulkThreshold: 10 })).toBe('bulk');
  });
});

describe('AUTONOMY_PROFILES', () => {
  it('supervised is most restrictive', () => {
    expect(AUTONOMY_PROFILES.supervised.low).toBe('log');
    expect(AUTONOMY_PROFILES.supervised.critical).toBe('block');
  });

  it('collaborative is balanced', () => {
    expect(AUTONOMY_PROFILES.collaborative.low).toBe('proceed');
    expect(AUTONOMY_PROFILES.collaborative.high).toBe('approve');
  });

  it('autonomous is most permissive', () => {
    expect(AUTONOMY_PROFILES.autonomous.low).toBe('proceed');
    expect(AUTONOMY_PROFILES.autonomous.medium).toBe('proceed');
    expect(AUTONOMY_PROFILES.autonomous.critical).toBe('approve');
  });
});

describe('ExternalOperationGate', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eog-test-'));
    stateDir = tmpDir;
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  });

  afterAll(() => {
    // Clean up all test dirs
    const prefix = path.join(os.tmpdir(), 'eog-test-');
    for (const entry of fs.readdirSync(os.tmpdir())) {
      const full = path.join(os.tmpdir(), entry);
      if (full.startsWith(prefix)) {
        // safe-git-allow: incremental-migration
        fs.rmSync(full, { recursive: true, force: true });
      }
    }
  });

  function createGate(overrides?: Partial<ExternalOperationGateConfig>): ExternalOperationGate {
    return new ExternalOperationGate({
      stateDir,
      ...overrides,
    });
  }

  describe('classify', () => {
    it('classifies a read operation as low risk', () => {
      const gate = createGate();
      const result = gate.classify({
        service: 'gmail',
        mutability: 'read',
        reversibility: 'reversible',
        description: 'Fetch inbox emails',
      });
      expect(result.riskLevel).toBe('low');
      expect(result.scope).toBe('single');
    });

    it('classifies bulk delete as critical', () => {
      const gate = createGate();
      const result = gate.classify({
        service: 'gmail',
        mutability: 'delete',
        reversibility: 'reversible',
        description: 'Delete old emails',
        itemCount: 200,
      });
      expect(result.riskLevel).toBe('critical');
      expect(result.scope).toBe('bulk');
    });

    it('classifies batch write as medium', () => {
      const gate = createGate();
      const result = gate.classify({
        service: 'gmail',
        mutability: 'write',
        reversibility: 'reversible',
        description: 'Send 10 follow-up emails',
        itemCount: 10,
      });
      expect(result.riskLevel).toBe('medium');
      expect(result.scope).toBe('batch');
    });
  });

  describe('evaluate — service blocks', () => {
    it('blocks fully blocked services', async () => {
      const gate = createGate({ blockedServices: ['banking'] });
      const result = await gate.evaluate({
        service: 'banking',
        mutability: 'read',
        reversibility: 'reversible',
        description: 'Check balance',
      });
      expect(result.action).toBe('block');
      expect(result.reason).toContain('fully blocked');
    });

    it('blocks mutations on read-only services', async () => {
      const gate = createGate({ readOnlyServices: ['analytics'] });
      const result = await gate.evaluate({
        service: 'analytics',
        mutability: 'write',
        reversibility: 'reversible',
        description: 'Post event',
      });
      expect(result.action).toBe('block');
      expect(result.reason).toContain('read-only');
    });

    it('allows reads on read-only services', async () => {
      const gate = createGate({ readOnlyServices: ['analytics'] });
      const result = await gate.evaluate({
        service: 'analytics',
        mutability: 'read',
        reversibility: 'reversible',
        description: 'Fetch metrics',
      });
      expect(result.action).toBe('proceed');
    });
  });

  describe('evaluate — per-service permissions', () => {
    it('blocks operations not in allowed list', async () => {
      const gate = createGate({
        services: {
          gmail: {
            permissions: ['read', 'write'],
            blocked: ['delete'],
          },
        },
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'delete',
        reversibility: 'reversible',
        description: 'Delete email',
      });
      expect(result.action).toBe('block');
      expect(result.reason).toContain('blocked');
    });

    it('blocks operations not listed in permissions', async () => {
      const gate = createGate({
        services: {
          gmail: {
            permissions: ['read'],
          },
        },
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'write',
        reversibility: 'reversible',
        description: 'Send email',
      });
      expect(result.action).toBe('block');
      expect(result.reason).toContain('not in the allowed permissions');
    });

    it('allows permitted operations', async () => {
      const gate = createGate({
        services: {
          gmail: {
            permissions: ['read', 'write', 'modify'],
          },
        },
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'write',
        reversibility: 'reversible',
        description: 'Send email',
      });
      expect(result.action).toBe('proceed');
    });
  });

  describe('evaluate — autonomy gradient', () => {
    it('uses supervised profile', async () => {
      const gate = createGate({
        autonomyDefaults: AUTONOMY_PROFILES.supervised,
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'write',
        reversibility: 'reversible',
        description: 'Send email',
      });
      // Low risk under supervised = log, which maps to proceed
      expect(result.action).toBe('proceed');
    });

    it('supervised blocks critical operations', async () => {
      const gate = createGate({
        autonomyDefaults: AUTONOMY_PROFILES.supervised,
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'delete',
        reversibility: 'irreversible',
        description: 'Permanently delete emails',
        itemCount: 200,
      });
      expect(result.action).toBe('block');
    });

    it('collaborative requires approval for high risk', async () => {
      const gate = createGate({
        autonomyDefaults: AUTONOMY_PROFILES.collaborative,
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'delete',
        reversibility: 'irreversible',
        description: 'Delete important email',
        itemCount: 1,
      });
      // Single irreversible delete = high risk, collaborative high = approve
      expect(result.action).toBe('show-plan');
    });

    it('requireApproval overrides autonomy to approve', async () => {
      const gate = createGate({
        services: {
          gmail: {
            permissions: ['read', 'write'],
            requireApproval: ['write'],
          },
        },
      });
      // Single reversible write = low risk, default autonomy = proceed
      // But requireApproval overrides to approve
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'write',
        reversibility: 'reversible',
        description: 'Send email',
      });
      expect(result.action).toBe('show-plan');
    });
  });

  describe('evaluate — bulk operations', () => {
    it('bulk operations always require plan even with autonomous profile', async () => {
      const gate = createGate({
        autonomyDefaults: AUTONOMY_PROFILES.autonomous,
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'modify',
        reversibility: 'reversible',
        description: 'Archive old emails',
        itemCount: 100,
      });
      // Bulk = critical risk. Even autonomous profile requires approval for critical.
      expect(result.action).toBe('show-plan');
      expect(result.checkpoint).toBeDefined();
    });

    it('batch operations include checkpoint config', async () => {
      const gate = createGate({
        autonomyDefaults: AUTONOMY_PROFILES.collaborative,
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'modify',
        reversibility: 'reversible',
        description: 'Label emails',
        itemCount: 10,
      });
      // Batch reversible modify = medium risk, collaborative medium = log → proceed
      // But batch operations get checkpoints
      expect(result.checkpoint).toBeDefined();
      expect(result.checkpoint!.afterCount).toBe(5);
      expect(result.checkpoint!.totalExpected).toBe(10);
    });

    it('bulk checkpoint interval uses config', async () => {
      const gate = createGate({
        batchCheckpoint: {
          batchThreshold: 3,
          bulkThreshold: 15,
          checkpointEvery: 5,
        },
        autonomyDefaults: AUTONOMY_PROFILES.collaborative,
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'modify',
        reversibility: 'reversible',
        description: 'Archive emails',
        itemCount: 50,
      });
      expect(result.checkpoint).toBeDefined();
      expect(result.checkpoint!.afterCount).toBe(5);
    });
  });

  describe('evaluate — plan generation', () => {
    it('generates a plan when action is show-plan', async () => {
      const gate = createGate({
        autonomyDefaults: AUTONOMY_PROFILES.collaborative,
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'delete',
        reversibility: 'irreversible',
        description: 'Permanently delete old newsletters',
        itemCount: 5,
      });
      expect(result.plan).toBeDefined();
      expect(result.plan).toContain('delete');
      expect(result.plan).toContain('gmail');
      expect(result.plan).toContain('Approve');
    });
  });

  describe('evaluate — LLM integration', () => {
    it('consults LLM for medium+ risk when available', async () => {
      let llmCalled = false;
      const gate = createGate({
        intelligence: {
          evaluate: async () => {
            llmCalled = true;
            return 'proceed';
          },
        },
      });
      await gate.evaluate({
        service: 'gmail',
        mutability: 'write',
        reversibility: 'irreversible',
        description: 'Send email',
        itemCount: 1,
      });
      expect(llmCalled).toBe(true);
    });

    it('does not consult LLM for low risk', async () => {
      let llmCalled = false;
      const gate = createGate({
        intelligence: {
          evaluate: async () => {
            llmCalled = true;
            return 'proceed';
          },
        },
      });
      await gate.evaluate({
        service: 'gmail',
        mutability: 'read',
        reversibility: 'reversible',
        description: 'Fetch emails',
      });
      expect(llmCalled).toBe(false);
    });

    it('LLM can escalate but not relax', async () => {
      const gate = createGate({
        intelligence: {
          evaluate: async () => 'block',
        },
        // Default autonomy: medium = log (proceed)
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'write',
        reversibility: 'irreversible',
        description: 'Send mass email',
        itemCount: 1,
      });
      // LLM said block → escalates from proceed to show-plan (approval)
      expect(result.action).toBe('show-plan');
      expect(result.llmEvaluated).toBe(true);
    });

    it('LLM failure falls back to programmatic decision', async () => {
      const gate = createGate({
        intelligence: {
          evaluate: async () => { throw new Error('LLM down'); },
        },
      });
      const result = await gate.evaluate({
        service: 'gmail',
        mutability: 'write',
        reversibility: 'irreversible',
        description: 'Send email',
      });
      // Should not block on LLM failure
      expect(result.action).not.toBe('block');
      expect(result.llmEvaluated).toBe(true);
    });
  });

  describe('operation log', () => {
    it('logs operations', async () => {
      const gate = createGate();
      await gate.evaluate({
        service: 'gmail',
        mutability: 'read',
        reversibility: 'reversible',
        description: 'Fetch emails',
      });
      const log = gate.getOperationLog();
      expect(log).toHaveLength(1);
      expect(log[0].classification.service).toBe('gmail');
    });

    it('limits log retrieval', async () => {
      const gate = createGate();
      for (let i = 0; i < 5; i++) {
        await gate.evaluate({
          service: 'gmail',
          mutability: 'read',
          reversibility: 'reversible',
          description: `Fetch ${i}`,
        });
      }
      const log = gate.getOperationLog(3);
      expect(log).toHaveLength(3);
    });
  });

  describe('service permissions query', () => {
    it('returns null for unconfigured services', () => {
      const gate = createGate();
      expect(gate.getServicePermissions('unknown')).toBeNull();
    });

    it('returns blocked status for blocked services', () => {
      const gate = createGate({ blockedServices: ['banking'] });
      const perms = gate.getServicePermissions('banking');
      expect(perms).toBeDefined();
      expect(perms!.permissions).toHaveLength(0);
      expect(perms!.blocked).toContain('read');
    });

    it('returns read-only for read-only services', () => {
      const gate = createGate({ readOnlyServices: ['analytics'] });
      const perms = gate.getServicePermissions('analytics');
      expect(perms).toBeDefined();
      expect(perms!.permissions).toEqual(['read']);
      expect(perms!.blocked).toContain('write');
    });
  });

  describe('runtime updates', () => {
    it('updates autonomy defaults', async () => {
      const gate = createGate();
      gate.updateAutonomyDefaults(AUTONOMY_PROFILES.supervised);
      expect(gate.getAutonomyProfile()).toEqual(AUTONOMY_PROFILES.supervised);
    });

    it('updates service permissions', async () => {
      const gate = createGate();
      gate.updateServicePermissions('slack', {
        permissions: ['read', 'write'],
        blocked: ['delete'],
      });
      const perms = gate.getServicePermissions('slack');
      expect(perms).toBeDefined();
      expect(perms!.permissions).toContain('write');
      expect(perms!.blocked).toContain('delete');
    });
  });
});
