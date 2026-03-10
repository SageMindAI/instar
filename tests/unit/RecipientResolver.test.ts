/**
 * Unit tests for RecipientResolver — Recipient context resolution for review decisions.
 *
 * Tests cover:
 * - Resolution with mock RelationshipManager returning XML context
 * - Resolution with no RelationshipManager (null)
 * - Default contexts for each recipient type
 * - Trust boundary: free-text fields are NOT included
 * - Agent trust level resolution via AdaptiveTrust
 */

import { describe, it, expect } from 'vitest';
import { RecipientResolver } from '../../src/core/RecipientResolver.js';
import type { RecipientContext, RecipientResolverOptions } from '../../src/core/RecipientResolver.js';

// ── Mock Helpers ──────────────────────────────────────────────────

function makeRelationshipXml(overrides?: {
  name?: string;
  significance?: number;
  themes?: string[];
  communicationStyle?: string;
  notes?: string;
  arcSummary?: string;
}): string {
  const name = overrides?.name ?? 'Alice';
  const sig = overrides?.significance ?? 7;
  const themes = overrides?.themes ?? ['typescript', 'agent-design'];
  const style = overrides?.communicationStyle ?? 'casual';
  const notes = overrides?.notes ?? 'Prefers short messages. Has a dog named Rex.';
  const arc = overrides?.arcSummary ?? 'Close collaborator since early days.';

  const lines = [
    `<relationship_context person="${name}">`,
    `Name: ${name}`,
    `Known since: 2025-06-01T00:00:00.000Z`,
    `Last interaction: 2026-03-08T12:00:00.000Z`,
    `Total interactions: 142`,
    `Significance: ${sig}/10`,
  ];

  if (themes.length > 0) {
    lines.push(`Key themes: ${themes.join(', ')}`);
  }

  if (style) {
    lines.push(`Communication style: ${style}`);
  }

  if (arc) {
    lines.push(`Relationship arc: ${arc}`);
  }

  if (notes) {
    lines.push(`Notes: ${notes}`);
  }

  lines.push('</relationship_context>');
  return lines.join('\n');
}

function mockRelationships(contextMap: Record<string, string | null>) {
  return {
    getContextForPerson(id: string): string | null {
      return contextMap[id] ?? null;
    },
  };
}

function mockAdaptiveTrust(floor: string = 'collaborative') {
  return {
    getProfile() {
      return {
        services: {},
        global: {
          maturity: 0.5,
          lastEvent: 'test',
          lastEventAt: new Date().toISOString(),
          floor,
        },
      };
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('RecipientResolver', () => {
  describe('defaults (no RelationshipManager)', () => {
    it('returns primary-user defaults', () => {
      const resolver = new RecipientResolver({ stateDir: '/tmp/test', relationships: null });
      const ctx = resolver.resolve(undefined, 'primary-user');

      expect(ctx.recipientType).toBe('primary-user');
      expect(ctx.communicationStyle).toBe('conversational');
      expect(ctx.significance).toBe('high');
    });

    it('returns secondary-user defaults', () => {
      const resolver = new RecipientResolver({ stateDir: '/tmp/test', relationships: null });
      const ctx = resolver.resolve(undefined, 'secondary-user');

      expect(ctx.recipientType).toBe('secondary-user');
      expect(ctx.communicationStyle).toBe('professional');
      expect(ctx.significance).toBe('medium');
    });

    it('returns agent defaults', () => {
      const resolver = new RecipientResolver({ stateDir: '/tmp/test', relationships: null });
      const ctx = resolver.resolve(undefined, 'agent');

      expect(ctx.recipientType).toBe('agent');
      expect(ctx.communicationStyle).toBe('technical');
      expect(ctx.trustLevel).toBe('untrusted');
    });

    it('returns external-contact defaults', () => {
      const resolver = new RecipientResolver({ stateDir: '/tmp/test', relationships: null });
      const ctx = resolver.resolve(undefined, 'external-contact');

      expect(ctx.recipientType).toBe('external-contact');
      expect(ctx.communicationStyle).toBe('professional');
      expect(ctx.significance).toBe('low');
      expect(ctx.formality).toBe('high');
    });

    it('falls back to external-contact for unknown type', () => {
      const resolver = new RecipientResolver({ stateDir: '/tmp/test', relationships: null });
      const ctx = resolver.resolve(undefined, undefined);

      expect(ctx.recipientType).toBe('external-contact');
      expect(ctx.communicationStyle).toBe('professional');
    });
  });

  describe('with RelationshipManager', () => {
    it('extracts structured metadata from XML context', () => {
      const xml = makeRelationshipXml({
        significance: 8,
        themes: ['infrastructure', 'deployment'],
        communicationStyle: 'formal',
      });

      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ 'user-1': xml }),
      });

      const ctx = resolver.resolve('user-1', 'primary-user');

      expect(ctx.recipientType).toBe('primary-user');
      expect(ctx.communicationStyle).toBe('formal');
      expect(ctx.significance).toBe('high'); // 8/10 → high
      expect(ctx.themes).toEqual(['infrastructure', 'deployment']);
      expect(ctx.formality).toBe('high'); // inferred from "formal"
    });

    it('maps significance levels correctly', () => {
      // Low significance (3/10)
      const xmlLow = makeRelationshipXml({ significance: 3 });
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ low: xmlLow }),
      });
      expect(resolver.resolve('low', 'primary-user').significance).toBe('low');

      // Medium significance (5/10)
      const xmlMed = makeRelationshipXml({ significance: 5 });
      const resolver2 = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ med: xmlMed }),
      });
      expect(resolver2.resolve('med', 'primary-user').significance).toBe('medium');

      // High significance (9/10)
      const xmlHigh = makeRelationshipXml({ significance: 9 });
      const resolver3 = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ high: xmlHigh }),
      });
      expect(resolver3.resolve('high', 'primary-user').significance).toBe('high');
    });

    it('falls back to defaults when recipientId is not found', () => {
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ 'user-1': null }),
      });

      const ctx = resolver.resolve('user-1', 'primary-user');
      expect(ctx.communicationStyle).toBe('conversational');
      expect(ctx.significance).toBe('high');
    });

    it('falls back to defaults when recipientId is not provided', () => {
      const xml = makeRelationshipXml();
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ 'user-1': xml }),
      });

      const ctx = resolver.resolve(undefined, 'secondary-user');
      expect(ctx.communicationStyle).toBe('professional');
      expect(ctx.significance).toBe('medium');
    });
  });

  describe('trust boundary — free-text exclusion', () => {
    it('does NOT include notes or description fields', () => {
      const xml = makeRelationshipXml({
        notes: 'Very private personal information here',
        arcSummary: 'Long detailed relationship history',
      });

      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ 'user-1': xml }),
      });

      const ctx = resolver.resolve('user-1', 'primary-user');

      // Only allowed fields should be present
      const allowedKeys = new Set(['recipientType', 'communicationStyle', 'significance', 'themes', 'trustLevel', 'formality']);
      for (const key of Object.keys(ctx)) {
        expect(allowedKeys.has(key)).toBe(true);
      }

      // Specifically: no raw context, notes, description, etc.
      const ctxAny = ctx as any;
      expect(ctxAny.notes).toBeUndefined();
      expect(ctxAny.description).toBeUndefined();
      expect(ctxAny.rawContext).toBeUndefined();
      expect(ctxAny.fullHistory).toBeUndefined();
      expect(ctxAny.personalDetails).toBeUndefined();
      expect(ctxAny.arcSummary).toBeUndefined();
    });

    it('does NOT leak notes content into any field', () => {
      const xml = makeRelationshipXml({
        notes: 'secret-passphrase-12345',
      });

      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ 'user-1': xml }),
      });

      const ctx = resolver.resolve('user-1', 'primary-user');
      const serialized = JSON.stringify(ctx);
      expect(serialized).not.toContain('secret-passphrase-12345');
    });
  });

  describe('agent trust level resolution', () => {
    it('resolves trust level from AdaptiveTrust for agent recipients', () => {
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: null,
        adaptiveTrust: mockAdaptiveTrust('collaborative'),
      });

      const ctx = resolver.resolve(undefined, 'agent');
      expect(ctx.recipientType).toBe('agent');
      expect(ctx.trustLevel).toBe('collaborative');
    });

    it('resolves supervised trust level', () => {
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: null,
        adaptiveTrust: mockAdaptiveTrust('supervised'),
      });

      const ctx = resolver.resolve(undefined, 'agent');
      expect(ctx.trustLevel).toBe('supervised');
    });

    it('falls back to untrusted when AdaptiveTrust is null', () => {
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: null,
        adaptiveTrust: null,
      });

      const ctx = resolver.resolve(undefined, 'agent');
      expect(ctx.trustLevel).toBe('untrusted');
    });

    it('falls back to untrusted when getProfile throws', () => {
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: null,
        adaptiveTrust: {
          getProfile() {
            throw new Error('trust file corrupted');
          },
        },
      });

      const ctx = resolver.resolve(undefined, 'agent');
      expect(ctx.trustLevel).toBe('untrusted');
    });

    it('does not query AdaptiveTrust for non-agent recipients', () => {
      let called = false;
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: null,
        adaptiveTrust: {
          getProfile() {
            called = true;
            return { global: { floor: 'collaborative' } };
          },
        },
      });

      const ctx = resolver.resolve(undefined, 'primary-user');
      expect(ctx.trustLevel).toBeUndefined();
      expect(called).toBe(false);
    });
  });

  describe('formality inference', () => {
    it('infers high formality from formal communication style', () => {
      const xml = makeRelationshipXml({ communicationStyle: 'formal' });
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ 'u1': xml }),
      });

      const ctx = resolver.resolve('u1', 'primary-user');
      expect(ctx.formality).toBe('high');
    });

    it('infers low formality from casual communication style', () => {
      const xml = makeRelationshipXml({ communicationStyle: 'casual' });
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ 'u1': xml }),
      });

      const ctx = resolver.resolve('u1', 'primary-user');
      expect(ctx.formality).toBe('low');
    });

    it('infers low formality from conversational style', () => {
      const xml = makeRelationshipXml({ communicationStyle: 'conversational' });
      const resolver = new RecipientResolver({
        stateDir: '/tmp/test',
        relationships: mockRelationships({ 'u1': xml }),
      });

      const ctx = resolver.resolve('u1', 'primary-user');
      expect(ctx.formality).toBe('low');
    });
  });
});
