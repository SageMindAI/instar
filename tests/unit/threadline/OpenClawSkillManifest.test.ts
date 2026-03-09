/**
 * Unit tests — OpenClawSkillManifest.
 *
 * Tests the skill manifest generation for publishing Threadline as an
 * OpenClaw skill on ClawHub.
 *
 * Part of Threadline Protocol Phase 6D.
 */

import { describe, it, expect } from 'vitest';

import { generateSkillManifest, type SkillManifest } from '../../../src/threadline/OpenClawSkillManifest.js';

// ── 1. generateSkillManifest — returns complete manifest ─────────────

describe('OpenClawSkillManifest', () => {
  describe('generateSkillManifest', () => {
    it('returns a complete manifest with all required fields', () => {
      const manifest = generateSkillManifest();
      expect(manifest).toHaveProperty('name');
      expect(manifest).toHaveProperty('description');
      expect(manifest).toHaveProperty('version');
      expect(manifest).toHaveProperty('author');
      expect(manifest).toHaveProperty('license');
      expect(manifest).toHaveProperty('actions');
      expect(manifest).toHaveProperty('providers');
      expect(manifest).toHaveProperty('evaluators');
      expect(manifest).toHaveProperty('configuration');
    });

    it('returns non-empty strings for all top-level fields', () => {
      const manifest = generateSkillManifest();
      expect(manifest.name.length).toBeGreaterThan(0);
      expect(manifest.description.length).toBeGreaterThan(0);
      expect(manifest.version.length).toBeGreaterThan(0);
      expect(manifest.author.length).toBeGreaterThan(0);
      expect(manifest.license.length).toBeGreaterThan(0);
    });
  });

  // ── 2. Actions ───────────────────────────────────────────────────────

  describe('actions', () => {
    it('has 4 actions', () => {
      const manifest = generateSkillManifest();
      expect(manifest.actions).toHaveLength(4);
    });

    it('includes THREADLINE_SEND action', () => {
      const manifest = generateSkillManifest();
      const action = manifest.actions.find(a => a.name === 'THREADLINE_SEND');
      expect(action).toBeDefined();
      expect(action!.description).toBeTruthy();
      expect(action!.examples.length).toBeGreaterThan(0);
    });

    it('includes THREADLINE_DISCOVER action', () => {
      const manifest = generateSkillManifest();
      const action = manifest.actions.find(a => a.name === 'THREADLINE_DISCOVER');
      expect(action).toBeDefined();
      expect(action!.description).toBeTruthy();
      expect(action!.examples.length).toBeGreaterThan(0);
    });

    it('includes THREADLINE_HISTORY action', () => {
      const manifest = generateSkillManifest();
      const action = manifest.actions.find(a => a.name === 'THREADLINE_HISTORY');
      expect(action).toBeDefined();
      expect(action!.description).toBeTruthy();
      expect(action!.examples.length).toBeGreaterThan(0);
    });

    it('includes THREADLINE_STATUS action', () => {
      const manifest = generateSkillManifest();
      const action = manifest.actions.find(a => a.name === 'THREADLINE_STATUS');
      expect(action).toBeDefined();
      expect(action!.description).toBeTruthy();
      expect(action!.examples.length).toBeGreaterThan(0);
    });

    it('each action has examples with user and content.text', () => {
      const manifest = generateSkillManifest();
      for (const action of manifest.actions) {
        for (const example of action.examples) {
          expect(example.length).toBeGreaterThan(0);
          expect(example[0]).toHaveProperty('user');
          expect(example[0]).toHaveProperty('content.text');
        }
      }
    });
  });

  // ── 3. Providers ─────────────────────────────────────────────────────

  describe('providers', () => {
    it('has 2 providers', () => {
      const manifest = generateSkillManifest();
      expect(manifest.providers).toHaveLength(2);
    });

    it('includes threadline-context provider', () => {
      const manifest = generateSkillManifest();
      const provider = manifest.providers.find(p => p.name === 'threadline-context');
      expect(provider).toBeDefined();
      expect(provider!.description).toBeTruthy();
    });

    it('includes threadline-identity provider', () => {
      const manifest = generateSkillManifest();
      const provider = manifest.providers.find(p => p.name === 'threadline-identity');
      expect(provider).toBeDefined();
      expect(provider!.description).toBeTruthy();
    });
  });

  // ── 4. Evaluators ────────────────────────────────────────────────────

  describe('evaluators', () => {
    it('has 2 evaluators', () => {
      const manifest = generateSkillManifest();
      expect(manifest.evaluators).toHaveLength(2);
    });

    it('includes threadline-trust evaluator', () => {
      const manifest = generateSkillManifest();
      const evaluator = manifest.evaluators.find(e => e.name === 'threadline-trust');
      expect(evaluator).toBeDefined();
      expect(evaluator!.description).toBeTruthy();
    });

    it('includes threadline-coherence evaluator', () => {
      const manifest = generateSkillManifest();
      const evaluator = manifest.evaluators.find(e => e.name === 'threadline-coherence');
      expect(evaluator).toBeDefined();
      expect(evaluator!.description).toBeTruthy();
    });
  });

  // ── 5. Configuration ────────────────────────────────────────────────

  describe('configuration', () => {
    it('has 6 config keys', () => {
      const manifest = generateSkillManifest();
      expect(Object.keys(manifest.configuration)).toHaveLength(6);
    });

    it('THREADLINE_STATE_DIR is required', () => {
      const manifest = generateSkillManifest();
      expect(manifest.configuration.THREADLINE_STATE_DIR).toBeDefined();
      expect(manifest.configuration.THREADLINE_STATE_DIR.required).toBe(true);
    });

    it('THREADLINE_AGENT_NAME is required', () => {
      const manifest = generateSkillManifest();
      expect(manifest.configuration.THREADLINE_AGENT_NAME).toBeDefined();
      expect(manifest.configuration.THREADLINE_AGENT_NAME.required).toBe(true);
    });

    it('optional keys are not required', () => {
      const manifest = generateSkillManifest();
      expect(manifest.configuration.THREADLINE_TRUST_DEFAULT.required).toBe(false);
      expect(manifest.configuration.THREADLINE_HOURLY_TOKEN_LIMIT.required).toBe(false);
      expect(manifest.configuration.THREADLINE_DAILY_TOKEN_LIMIT.required).toBe(false);
      expect(manifest.configuration.THREADLINE_DISCOVERY_ENDPOINT.required).toBe(false);
    });

    it('each config key has type and description', () => {
      const manifest = generateSkillManifest();
      for (const [key, config] of Object.entries(manifest.configuration)) {
        expect(config.type).toBeTruthy();
        expect(config.description).toBeTruthy();
      }
    });

    it('THREADLINE_TRUST_DEFAULT has a default value', () => {
      const manifest = generateSkillManifest();
      expect(manifest.configuration.THREADLINE_TRUST_DEFAULT.default).toBe('untrusted');
    });
  });

  // ── 6. Version ───────────────────────────────────────────────────────

  describe('version', () => {
    it('uses default version 0.1.0', () => {
      const manifest = generateSkillManifest();
      expect(manifest.version).toBe('0.1.0');
    });

    it('accepts custom version', () => {
      const manifest = generateSkillManifest('1.2.3');
      expect(manifest.version).toBe('1.2.3');
    });
  });

  // ── 7. Metadata ──────────────────────────────────────────────────────

  describe('metadata', () => {
    it('has correct name', () => {
      const manifest = generateSkillManifest();
      expect(manifest.name).toBe('@threadline/openclaw-skill');
    });

    it('has correct author', () => {
      const manifest = generateSkillManifest();
      expect(manifest.author).toBe('SageMindAI');
    });

    it('has MIT license', () => {
      const manifest = generateSkillManifest();
      expect(manifest.license).toBe('MIT');
    });
  });
});
