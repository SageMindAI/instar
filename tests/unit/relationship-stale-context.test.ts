/**
 * Relationship staleness detection and context generation tests.
 * Validates that stale relationship detection works correctly
 * and context generation produces proper structured output.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import type { RelationshipManagerConfig, RelationshipRecord } from '../../src/core/types.js';

describe('Relationship stale detection and context', () => {
  let dir: string;
  let config: RelationshipManagerConfig;
  let manager: RelationshipManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rel-'));
    config = { relationshipsDir: dir, maxRecentInteractions: 10 };
    manager = new RelationshipManager(config);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function createRecord(overrides: Partial<RelationshipRecord> = {}): RelationshipRecord {
    const id = overrides.id || randomUUID();
    return {
      id,
      name: 'Test Person',
      channels: [{ type: 'telegram', identifier: '123' }],
      firstInteraction: new Date().toISOString(),
      lastInteraction: new Date().toISOString(),
      interactionCount: 1,
      themes: [],
      notes: '',
      significance: 5,
      recentInteractions: [],
      ...overrides,
    };
  }

  // Deterministic UUIDs for test assertions
  const STALE_ID = '00000000-0000-4000-a000-000000000001';
  const LOWSIG_ID = '00000000-0000-4000-a000-000000000002';
  const RECENT_ID = '00000000-0000-4000-a000-000000000003';
  const MEDIUM_ID = '00000000-0000-4000-a000-000000000004';
  const CTX_ID = '00000000-0000-4000-a000-000000000005';
  const MINIMAL_ID = '00000000-0000-4000-a000-000000000006';
  const INTERACT_ID = '00000000-0000-4000-a000-000000000007';

  describe('Stale detection', () => {
    it('finds relationships not contacted in X days', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30);

      // Create a stale relationship (significance >= 3)
      const record = createRecord({
        id: STALE_ID,
        lastInteraction: oldDate.toISOString(),
        significance: 5,
      });
      fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));

      // Reload to pick up the file
      const freshManager = new RelationshipManager(config);
      const stale = freshManager.getStaleRelationships(14);
      expect(stale.length).toBe(1);
      expect(stale[0].id).toBe(STALE_ID);
    });

    it('ignores low-significance relationships', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30);

      const record = createRecord({
        id: LOWSIG_ID,
        lastInteraction: oldDate.toISOString(),
        significance: 2, // Below threshold of 3
      });
      fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));

      const freshManager = new RelationshipManager(config);
      const stale = freshManager.getStaleRelationships(14);
      expect(stale.length).toBe(0);
    });

    it('ignores recently contacted relationships', () => {
      const record = createRecord({
        id: RECENT_ID,
        lastInteraction: new Date().toISOString(),
        significance: 10,
      });
      fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));

      const freshManager = new RelationshipManager(config);
      const stale = freshManager.getStaleRelationships(14);
      expect(stale.length).toBe(0);
    });

    it('respects custom days threshold', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);

      const record = createRecord({
        id: MEDIUM_ID,
        lastInteraction: oldDate.toISOString(),
        significance: 5,
      });
      fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));

      const freshManager = new RelationshipManager(config);

      // 7 days threshold — should find it
      const stale7 = freshManager.getStaleRelationships(7);
      expect(stale7.length).toBe(1);

      // 14 days threshold — should NOT find it
      const stale14 = freshManager.getStaleRelationships(14);
      expect(stale14.length).toBe(0);
    });
  });

  describe('Context generation', () => {
    it('returns null for unknown person', () => {
      expect(manager.getContextForPerson('nonexistent')).toBeNull();
    });

    it('generates structured XML context', () => {
      const record = createRecord({
        id: CTX_ID,
        name: 'Alice',
        themes: ['AI', 'philosophy'],
        communicationStyle: 'technical and direct',
        arcSummary: 'Met at conference, became regular collaborator',
        notes: 'Prefers code examples',
        significance: 8,
      });
      fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));

      const freshManager = new RelationshipManager(config);
      const context = freshManager.getContextForPerson(CTX_ID);

      expect(context).not.toBeNull();
      expect(context).toContain('<relationship_context person="Alice">');
      expect(context).toContain('</relationship_context>');
      expect(context).toContain('Name: Alice');
      expect(context).toContain('Significance: 8/10');
      expect(context).toContain('Key themes: AI, philosophy');
      expect(context).toContain('Communication style: technical and direct');
      expect(context).toContain('Relationship arc: Met at conference');
      expect(context).toContain('Notes: Prefers code examples');
    });

    it('omits optional fields when not present', () => {
      const record = createRecord({
        id: MINIMAL_ID,
        name: 'Bob',
        themes: [],
        significance: 3,
      });
      fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));

      const freshManager = new RelationshipManager(config);
      const context = freshManager.getContextForPerson(MINIMAL_ID);

      expect(context).not.toBeNull();
      expect(context).toContain('Name: Bob');
      expect(context).not.toContain('Key themes:');
      expect(context).not.toContain('Communication style:');
      expect(context).not.toContain('Relationship arc:');
    });

    it('includes recent interactions (last 5)', () => {
      const record = createRecord({
        id: INTERACT_ID,
        name: 'Carol',
        recentInteractions: [
          { timestamp: '2024-01-01', channel: 'telegram', summary: 'Discussed project' },
          { timestamp: '2024-01-02', channel: 'email', summary: 'Sent draft' },
          { timestamp: '2024-01-03', channel: 'telegram', summary: 'Reviewed feedback' },
          { timestamp: '2024-01-04', channel: 'telegram', summary: 'Planning call' },
          { timestamp: '2024-01-05', channel: 'telegram', summary: 'Final review' },
          { timestamp: '2024-01-06', channel: 'telegram', summary: 'Ship it' },
        ],
      });
      fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));

      const freshManager = new RelationshipManager(config);
      const context = freshManager.getContextForPerson(INTERACT_ID);

      expect(context).toContain('Recent interactions:');
      // Should show last 5, not all 6
      expect(context).not.toContain('Discussed project');
      expect(context).toContain('Ship it');
    });
  });
});
