/**
 * Tests for the unified ConfigDefaults system.
 *
 * These tests structurally enforce that init and migration stay in sync.
 * If a test here fails, it means a new config field was added to one path
 * but not the other — exactly the bug this system prevents.
 */

import { describe, it, expect } from 'vitest';
import { getInitDefaults, getMigrationDefaults, applyDefaults } from '../../src/config/ConfigDefaults.js';

describe('ConfigDefaults', () => {
  describe('getInitDefaults', () => {
    it('returns defaults for managed-project', () => {
      const defaults = getInitDefaults('managed-project');
      expect(defaults.monitoring).toBeDefined();
      expect((defaults.monitoring as any).promptGate.enabled).toBe(true);
      expect((defaults.monitoring as any).quotaTracking).toBe(false);
    });

    it('returns defaults for standalone', () => {
      const defaults = getInitDefaults('standalone');
      expect((defaults.monitoring as any).quotaTracking).toBe(true);
    });

    it('includes externalOperations', () => {
      const defaults = getInitDefaults('managed-project');
      expect(defaults.externalOperations).toBeDefined();
      expect((defaults.externalOperations as any).trust.floor).toBe('collaborative');
    });

    it('includes threadline', () => {
      const defaults = getInitDefaults('managed-project');
      expect(defaults.threadline).toBeDefined();
      expect((defaults.threadline as any).relayEnabled).toBe(false);
    });
  });

  describe('getMigrationDefaults', () => {
    it('uses conservative trust settings', () => {
      const defaults = getMigrationDefaults('managed-project');
      expect((defaults.externalOperations as any).trust.floor).toBe('supervised');
      expect((defaults.externalOperations as any).trust.autoElevateEnabled).toBe(false);
    });

    it('still includes promptGate', () => {
      const defaults = getMigrationDefaults('managed-project');
      expect((defaults.monitoring as any).promptGate.enabled).toBe(true);
    });
  });

  describe('applyDefaults', () => {
    it('adds missing keys', () => {
      const config: Record<string, unknown> = {};
      const defaults = getInitDefaults('managed-project');
      const { patched, changes } = applyDefaults(config, defaults);

      expect(patched).toBe(true);
      expect(changes.length).toBeGreaterThan(0);
      expect((config.monitoring as any).promptGate.enabled).toBe(true);
    });

    it('never overwrites existing values', () => {
      const config: Record<string, unknown> = {
        monitoring: { promptGate: { enabled: false } },
      };
      const defaults = getInitDefaults('managed-project');
      applyDefaults(config, defaults);

      expect((config.monitoring as any).promptGate.enabled).toBe(false);
    });

    it('is idempotent', () => {
      const config: Record<string, unknown> = {};
      const defaults = getInitDefaults('standalone');
      const first = applyDefaults(config, defaults);
      const second = applyDefaults(config, defaults);

      expect(first.patched).toBe(true);
      expect(second.patched).toBe(false);
      expect(second.changes).toHaveLength(0);
    });

    it('respects _instar_noMigrate for top-level keys', () => {
      const config: Record<string, unknown> = {
        _instar_noMigrate: ['externalOperations', 'threadline'],
      };
      const defaults = getInitDefaults('managed-project');
      const { skipped } = applyDefaults(config, defaults);

      // externalOperations and threadline should be skipped
      expect(skipped.some(s => s.includes('externalOperations'))).toBe(true);
      expect(skipped.some(s => s.includes('threadline'))).toBe(true);
      // But monitoring should still be added
      expect(config.monitoring).toBeDefined();
      expect((config.monitoring as any).promptGate.enabled).toBe(true);
    });

    it('treats arrays as opaque leaves', () => {
      const config: Record<string, unknown> = {
        threadline: { capabilities: ['chat', 'voice'] },
      };
      const defaults = getInitDefaults('managed-project');
      applyDefaults(config, defaults);

      // Should NOT merge/concatenate — should leave existing array alone
      expect((config.threadline as any).capabilities).toEqual(['chat', 'voice']);
    });

    it('handles type mismatches gracefully', () => {
      const config: Record<string, unknown> = {
        monitoring: true, // boolean instead of object — should not crash
      };
      const defaults = getInitDefaults('managed-project');

      // Should not throw
      expect(() => applyDefaults(config, defaults)).not.toThrow();
      // Should not overwrite the boolean
      expect(config.monitoring).toBe(true);
    });

    it('adds nested keys to existing objects', () => {
      const config: Record<string, unknown> = {
        monitoring: { quotaTracking: true },
      };
      const defaults = getInitDefaults('managed-project');
      applyDefaults(config, defaults);

      // Should add promptGate inside existing monitoring object
      expect((config.monitoring as any).promptGate).toBeDefined();
      expect((config.monitoring as any).promptGate.enabled).toBe(true);
      // Should NOT overwrite existing quotaTracking
      expect((config.monitoring as any).quotaTracking).toBe(true);
    });
  });

  describe('init/migration equivalence', () => {
    it('migration defaults cover all init default keys', () => {
      const initDefaults = getInitDefaults('managed-project');
      const migrationDefaults = getMigrationDefaults('managed-project');

      // Every top-level key in init should exist in migration
      for (const key of Object.keys(initDefaults)) {
        expect(migrationDefaults).toHaveProperty(key);
      }
    });

    it('migration defaults cover standalone init keys', () => {
      const initDefaults = getInitDefaults('standalone');
      const migrationDefaults = getMigrationDefaults('standalone');

      for (const key of Object.keys(initDefaults)) {
        expect(migrationDefaults).toHaveProperty(key);
      }
    });
  });
});
