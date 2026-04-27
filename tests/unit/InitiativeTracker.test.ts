/**
 * InitiativeTracker unit tests.
 *
 * Covers:
 *  - CRUD lifecycle (create, get, list, update, remove)
 *  - Validation (id format, unique, phase required)
 *  - Phase status transitions (startedAt/completedAt timestamps,
 *    currentPhaseIndex recalculation, auto-complete when all done)
 *  - Persistence across instances (atomic write + reload)
 *  - Digest scan: stale / needs-user / ready-to-advance / next-check-due
 *  - Ordering (list sorted by lastTouchedAt DESC)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  InitiativeTracker,
  STALE_THRESHOLD_MS,
} from '../../src/core/InitiativeTracker.js';

let tmpDir: string;
let tracker: InitiativeTracker;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'initiatives-test-'));
  tracker = new InitiativeTracker(tmpDir);
});

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseInput(id = 'demo') {
  return {
    id,
    title: 'Demo Initiative',
    description: 'A worked example for tests.',
    phases: [
      { id: 'plan', name: 'Plan' },
      { id: 'build', name: 'Build' },
      { id: 'ship', name: 'Ship' },
    ],
  };
}

describe('InitiativeTracker — CRUD', () => {
  it('creates an initiative with sane defaults', () => {
    const created = tracker.create(baseInput());
    expect(created.id).toBe('demo');
    expect(created.status).toBe('active');
    expect(created.phases).toHaveLength(3);
    expect(created.phases[0].status).toBe('pending');
    expect(created.currentPhaseIndex).toBe(0);
    expect(created.needsUser).toBe(false);
    expect(created.blockers).toEqual([]);
    expect(created.links).toEqual([]);
    expect(created.createdAt).toBe(created.updatedAt);
  });

  it('rejects duplicate ids', () => {
    tracker.create(baseInput());
    expect(() => tracker.create(baseInput())).toThrow(/already exists/);
  });

  it('rejects invalid id format', () => {
    expect(() => tracker.create({ ...baseInput(), id: 'Bad_ID' })).toThrow();
    expect(() => tracker.create({ ...baseInput(), id: '-leading-dash' })).toThrow();
    expect(() => tracker.create({ ...baseInput(), id: '' })).toThrow();
  });

  it('rejects empty phases array', () => {
    expect(() => tracker.create({ ...baseInput(), phases: [] })).toThrow(/at least one phase/);
  });

  it('lists initiatives sorted by lastTouchedAt DESC', async () => {
    tracker.create(baseInput('a'));
    await new Promise((r) => setTimeout(r, 5));
    tracker.create(baseInput('b'));
    await new Promise((r) => setTimeout(r, 5));
    tracker.update('a', { description: 'touched' });
    const listed = tracker.list();
    expect(listed.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('filters list by status', () => {
    tracker.create(baseInput('a'));
    tracker.create(baseInput('b'));
    tracker.update('b', { status: 'archived' });
    expect(tracker.list({ status: 'active' }).map((i) => i.id)).toEqual(['a']);
    expect(tracker.list({ status: 'archived' }).map((i) => i.id)).toEqual(['b']);
  });

  it('update() modifies fields and bumps timestamps', async () => {
    const created = tracker.create(baseInput());
    await new Promise((r) => setTimeout(r, 5));
    const updated = tracker.update('demo', {
      title: 'Renamed',
      needsUser: true,
      needsUserReason: 'decide scope',
    });
    expect(updated.title).toBe('Renamed');
    expect(updated.needsUser).toBe(true);
    expect(updated.needsUserReason).toBe('decide scope');
    expect(updated.updatedAt > created.updatedAt).toBe(true);
  });

  it('update() clears nullable fields when set to null', () => {
    tracker.create({ ...baseInput(), nextCheckAt: '2099-01-01T00:00:00.000Z' });
    const cleared = tracker.update('demo', { nextCheckAt: null });
    expect(cleared.nextCheckAt).toBeUndefined();
  });

  it('remove() deletes and returns true', () => {
    tracker.create(baseInput());
    expect(tracker.remove('demo')).toBe(true);
    expect(tracker.get('demo')).toBeUndefined();
  });

  it('remove() returns false for unknown id', () => {
    expect(tracker.remove('ghost')).toBe(false);
  });
});

describe('InitiativeTracker — phase transitions', () => {
  it('marks startedAt when phase first goes in-progress', () => {
    tracker.create(baseInput());
    const updated = tracker.setPhaseStatus('demo', 'plan', 'in-progress');
    expect(updated.phases[0].status).toBe('in-progress');
    expect(updated.phases[0].startedAt).toBeDefined();
    expect(updated.phases[0].completedAt).toBeUndefined();
  });

  it('marks completedAt when phase first goes done', () => {
    tracker.create(baseInput());
    const updated = tracker.setPhaseStatus('demo', 'plan', 'done');
    expect(updated.phases[0].completedAt).toBeDefined();
  });

  it('advances currentPhaseIndex past completed phases', () => {
    tracker.create(baseInput());
    const a = tracker.setPhaseStatus('demo', 'plan', 'done');
    expect(a.currentPhaseIndex).toBe(1);
    const b = tracker.setPhaseStatus('demo', 'build', 'done');
    expect(b.currentPhaseIndex).toBe(2);
  });

  it('marks initiative completed when all phases are done', () => {
    tracker.create(baseInput());
    tracker.setPhaseStatus('demo', 'plan', 'done');
    tracker.setPhaseStatus('demo', 'build', 'done');
    const final = tracker.setPhaseStatus('demo', 'ship', 'done');
    expect(final.status).toBe('completed');
    expect(final.currentPhaseIndex).toBe(2);
  });

  it('reverts to active when a completed initiative has a phase reopened', () => {
    tracker.create(baseInput());
    tracker.setPhaseStatus('demo', 'plan', 'done');
    tracker.setPhaseStatus('demo', 'build', 'done');
    tracker.setPhaseStatus('demo', 'ship', 'done');
    const reopened = tracker.setPhaseStatus('demo', 'ship', 'in-progress');
    expect(reopened.status).toBe('active');
  });

  it('throws on unknown phase id', () => {
    tracker.create(baseInput());
    expect(() => tracker.setPhaseStatus('demo', 'ghost', 'done')).toThrow(/not found/);
  });

  it('throws on unknown initiative id', () => {
    expect(() => tracker.setPhaseStatus('ghost', 'plan', 'done')).toThrow(/not found/);
  });
});

describe('InitiativeTracker — persistence', () => {
  it('round-trips through a second instance', () => {
    tracker.create(baseInput());
    tracker.setPhaseStatus('demo', 'plan', 'done');
    const reloaded = new InitiativeTracker(tmpDir);
    const fetched = reloaded.get('demo');
    expect(fetched).toBeDefined();
    expect(fetched!.phases[0].status).toBe('done');
    expect(fetched!.currentPhaseIndex).toBe(1);
  });

  it('writes to initiatives.json in stateDir', () => {
    tracker.create(baseInput());
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'initiatives.json'), 'utf-8'));
    expect(raw.initiatives).toHaveLength(1);
    expect(raw.initiatives[0].id).toBe('demo');
  });

  it('tolerates missing state file on construction', () => {
    const fresh = new InitiativeTracker(path.join(tmpDir, 'does-not-exist'));
    expect(fresh.list()).toEqual([]);
  });

  it('tolerates corrupt state file without throwing', () => {
    fs.writeFileSync(path.join(tmpDir, 'initiatives.json'), '{not valid json');
    // Constructor should swallow parse errors and behave like empty state.
    const fresh = new InitiativeTracker(tmpDir);
    expect(fresh.list()).toEqual([]);
  });
});

describe('InitiativeTracker — digest', () => {
  it('emits needs-user items first', () => {
    tracker.create({
      ...baseInput('a'),
      needsUser: true,
      needsUserReason: 'pick scope',
    });
    const d = tracker.digest();
    expect(d.items).toHaveLength(1);
    expect(d.items[0].reason).toBe('needs-user');
    expect(d.items[0].detail).toBe('pick scope');
  });

  it('emits ready-to-advance when current phase is done but more remain', () => {
    tracker.create(baseInput('a'));
    tracker.setPhaseStatus('a', 'plan', 'done');
    const d = tracker.digest();
    expect(d.items).toHaveLength(1);
    expect(d.items[0].reason).toBe('ready-to-advance');
    expect(d.items[0].detail).toMatch(/Plan.*Build/);
  });

  it('emits stale when lastTouchedAt is older than STALE_THRESHOLD_MS', () => {
    tracker.create(baseInput('a'));
    const future = new Date(Date.now() + STALE_THRESHOLD_MS + 60_000);
    const d = tracker.digest(future);
    expect(d.items).toHaveLength(1);
    expect(d.items[0].reason).toBe('stale');
  });

  it('emits next-check-due when nextCheckAt is in the past', () => {
    const pastISO = new Date(Date.now() - 60_000).toISOString();
    tracker.create({ ...baseInput('a'), nextCheckAt: pastISO });
    const d = tracker.digest();
    expect(d.items).toHaveLength(1);
    expect(d.items[0].reason).toBe('next-check-due');
  });

  it('does NOT emit for completed initiatives', () => {
    tracker.create(baseInput('a'));
    tracker.setPhaseStatus('a', 'plan', 'done');
    tracker.setPhaseStatus('a', 'build', 'done');
    tracker.setPhaseStatus('a', 'ship', 'done');
    const d = tracker.digest();
    expect(d.items).toHaveLength(0);
  });

  it('does NOT emit for archived initiatives', () => {
    tracker.create(baseInput('a'));
    tracker.update('a', { status: 'archived' });
    const future = new Date(Date.now() + STALE_THRESHOLD_MS * 10);
    expect(tracker.digest(future).items).toHaveLength(0);
  });

  it('returns empty items when everything is healthy', () => {
    tracker.create(baseInput('a'));
    const d = tracker.digest();
    expect(d.items).toEqual([]);
  });
});
