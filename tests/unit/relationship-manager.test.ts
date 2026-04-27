/**
 * Tests for RelationshipManager — CRUD, cross-platform resolution, significance, and merge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import type { UserChannel, InteractionSummary } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('RelationshipManager', () => {
  let tmpDir: string;
  let manager: RelationshipManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-test-'));
    manager = new RelationshipManager({
      relationshipsDir: tmpDir,
      maxRecentInteractions: 10,
    });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const telegramChannel: UserChannel = { type: 'telegram', identifier: '12345' };
  const emailChannel: UserChannel = { type: 'email', identifier: 'alice@example.com' };

  describe('findOrCreate', () => {
    it('creates a new relationship for unknown channel', () => {
      const record = manager.findOrCreate('Alice', telegramChannel);

      expect(record.name).toBe('Alice');
      expect(record.id).toBeTruthy();
      expect(record.channels).toHaveLength(1);
      expect(record.channels[0]).toEqual(telegramChannel);
      expect(record.interactionCount).toBe(0);
      expect(record.significance).toBe(1);
    });

    it('returns existing relationship for known channel', () => {
      const first = manager.findOrCreate('Alice', telegramChannel);
      const second = manager.findOrCreate('Alice', telegramChannel);

      expect(second.id).toBe(first.id);
    });

    it('persists to disk', () => {
      const record = manager.findOrCreate('Bob', emailChannel);
      const filePath = path.join(tmpDir, `${record.id}.json`);

      expect(fs.existsSync(filePath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(saved.name).toBe('Bob');
    });
  });

  describe('resolveByChannel', () => {
    it('resolves a known channel to its relationship', () => {
      const created = manager.findOrCreate('Alice', telegramChannel);
      const resolved = manager.resolveByChannel(telegramChannel);

      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(created.id);
    });

    it('returns null for unknown channel', () => {
      expect(manager.resolveByChannel({ type: 'slack', identifier: 'U123' })).toBeNull();
    });
  });

  describe('recordInteraction', () => {
    it('updates interaction count and recency', () => {
      const record = manager.findOrCreate('Alice', telegramChannel);
      const interaction: InteractionSummary = {
        timestamp: new Date().toISOString(),
        channel: 'telegram',
        summary: 'Discussed AI consciousness',
        topics: ['AI', 'consciousness'],
      };

      manager.recordInteraction(record.id, interaction);

      const updated = manager.get(record.id)!;
      expect(updated.interactionCount).toBe(1);
      expect(updated.recentInteractions).toHaveLength(1);
      expect(updated.themes).toContain('AI');
      expect(updated.themes).toContain('consciousness');
    });

    it('trims recent interactions to max', () => {
      const mgr = new RelationshipManager({
        relationshipsDir: tmpDir,
        maxRecentInteractions: 3,
      });
      const record = mgr.findOrCreate('Alice', telegramChannel);

      for (let i = 0; i < 5; i++) {
        mgr.recordInteraction(record.id, {
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          channel: 'telegram',
          summary: `Interaction ${i}`,
        });
      }

      const updated = mgr.get(record.id)!;
      expect(updated.recentInteractions).toHaveLength(3);
      expect(updated.interactionCount).toBe(5);
    });

    it('updates significance based on frequency', () => {
      const record = manager.findOrCreate('Alice', telegramChannel);

      for (let i = 0; i < 5; i++) {
        manager.recordInteraction(record.id, {
          timestamp: new Date().toISOString(),
          channel: 'telegram',
          summary: `Interaction ${i}`,
          topics: [`topic-${i}`],
        });
      }

      const updated = manager.get(record.id)!;
      // Should have significance > 1 with 5 interactions + recent + some themes
      expect(updated.significance).toBeGreaterThan(1);
    });

    it('significance floors at 1 for new relationships', () => {
      const record = manager.findOrCreate('NewPerson', telegramChannel);
      // 0 interactions, but significance should be at least 1 (minimum)
      expect(record.significance).toBe(1);
    });

    it('significance grows with many interactions and diverse themes', () => {
      const record = manager.findOrCreate('Power', telegramChannel);

      // 50+ interactions with 10+ themes → should reach high significance
      for (let i = 0; i < 55; i++) {
        manager.recordInteraction(record.id, {
          timestamp: new Date().toISOString(),
          channel: 'telegram',
          summary: `Deep conversation ${i}`,
          topics: [`topic-${i % 12}`], // 12 unique themes
        });
      }

      const updated = manager.get(record.id)!;
      // Frequency(4) + Recency(3) + Themes(3) = 10 → capped at 10
      expect(updated.significance).toBe(10);
    });

    it('significance decays when interactions are old', () => {
      const record = manager.findOrCreate('Fading', telegramChannel);

      // Record many old interactions
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
      for (let i = 0; i < 25; i++) {
        manager.recordInteraction(record.id, {
          timestamp: oldDate.toISOString(),
          channel: 'telegram',
          summary: `Old chat ${i}`,
          topics: [`old-${i % 6}`],
        });
      }

      const updated = manager.get(record.id)!;
      // Frequency(3) + Recency(0, >30 days) + Themes(2, 6 themes) = 5
      expect(updated.significance).toBe(5);
    });
  });

  describe('linkChannel', () => {
    it('adds new channel to existing relationship', () => {
      const record = manager.findOrCreate('Alice', telegramChannel);
      manager.linkChannel(record.id, emailChannel);

      const updated = manager.get(record.id)!;
      expect(updated.channels).toHaveLength(2);

      // Cross-platform resolution should work
      const resolved = manager.resolveByChannel(emailChannel);
      expect(resolved!.id).toBe(record.id);
    });

    it('does not duplicate existing channel', () => {
      const record = manager.findOrCreate('Alice', telegramChannel);
      manager.linkChannel(record.id, telegramChannel);

      const updated = manager.get(record.id)!;
      expect(updated.channels).toHaveLength(1);
    });
  });

  describe('mergeRelationships', () => {
    it('merges two records into one', () => {
      const alice1 = manager.findOrCreate('Alice', telegramChannel);
      const alice2 = manager.findOrCreate('Alice (email)', emailChannel);

      manager.recordInteraction(alice1.id, {
        timestamp: '2026-01-01T00:00:00Z',
        channel: 'telegram',
        summary: 'Telegram chat',
      });
      manager.recordInteraction(alice2.id, {
        timestamp: '2026-01-02T00:00:00Z',
        channel: 'email',
        summary: 'Email exchange',
      });

      manager.mergeRelationships(alice1.id, alice2.id);

      const merged = manager.get(alice1.id)!;
      expect(merged.channels).toHaveLength(2);
      expect(merged.interactionCount).toBe(2);
      expect(merged.recentInteractions).toHaveLength(2);

      // Old record should be gone
      expect(manager.get(alice2.id)).toBeNull();
    });
  });

  describe('getAll', () => {
    it('returns all relationships sorted by significance', () => {
      const alice = manager.findOrCreate('Alice', telegramChannel);
      const bob = manager.findOrCreate('Bob', emailChannel);

      // Give Alice more interactions to boost significance
      for (let i = 0; i < 5; i++) {
        manager.recordInteraction(alice.id, {
          timestamp: new Date().toISOString(),
          channel: 'telegram',
          summary: `Chat ${i}`,
        });
      }

      const all = manager.getAll('significance');
      expect(all).toHaveLength(2);
      expect(all[0].name).toBe('Alice'); // Higher significance
    });

    it('sorts by name', () => {
      manager.findOrCreate('Zara', telegramChannel);
      manager.findOrCreate('Alice', emailChannel);

      const all = manager.getAll('name');
      expect(all[0].name).toBe('Alice');
      expect(all[1].name).toBe('Zara');
    });
  });

  describe('getContextForPerson', () => {
    it('generates context string with relationship data', () => {
      const record = manager.findOrCreate('Alice', telegramChannel);
      manager.recordInteraction(record.id, {
        timestamp: new Date().toISOString(),
        channel: 'telegram',
        summary: 'Discussed emergence',
        topics: ['consciousness', 'emergence'],
      });

      const context = manager.getContextForPerson(record.id);
      expect(context).toContain('relationship_context');
      expect(context).toContain('Alice');
      expect(context).toContain('consciousness, emergence');
    });

    it('returns null for unknown ID', () => {
      expect(manager.getContextForPerson('nonexistent')).toBeNull();
    });
  });

  describe('getStaleRelationships', () => {
    it('returns relationships not contacted recently with sufficient significance', () => {
      const record = manager.findOrCreate('OldFriend', telegramChannel);

      // Manually set last interaction to 20 days ago and boost significance
      const updated = manager.get(record.id)!;
      updated.lastInteraction = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      updated.significance = 5;
      // Save directly by re-finding and modifying
      const filePath = path.join(tmpDir, `${record.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(updated));

      // Reload
      const mgr2 = new RelationshipManager({
        relationshipsDir: tmpDir,
        maxRecentInteractions: 10,
      });

      const stale = mgr2.getStaleRelationships(14);
      expect(stale.some(r => r.name === 'OldFriend')).toBe(true);
    });
  });

  describe('persistence across restarts', () => {
    it('loads relationships from disk on construction', () => {
      const record = manager.findOrCreate('Persistent', telegramChannel);

      // Create a new manager pointing to same dir
      const mgr2 = new RelationshipManager({
        relationshipsDir: tmpDir,
        maxRecentInteractions: 10,
      });

      const loaded = mgr2.get(record.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('Persistent');
    });

    it('rebuilds channel index on load', () => {
      manager.findOrCreate('Alice', telegramChannel);

      const mgr2 = new RelationshipManager({
        relationshipsDir: tmpDir,
        maxRecentInteractions: 10,
      });

      const resolved = mgr2.resolveByChannel(telegramChannel);
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('Alice');
    });
  });
});
