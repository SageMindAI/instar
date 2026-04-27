/**
 * Tests for SoulManager — self-authored identity management.
 *
 * Covers: trust enforcement, pending queue, drift detection,
 * integrity hashing, audit trail, and section manipulation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SoulManager, SoulError } from '../../src/core/SoulManager.js';
import { generateSoulMd } from '../../src/scaffold/templates.js';

// ── Test Setup ──────────────────────────────────────────────────────

interface TestSetup {
  dir: string;
  stateDir: string;
  manager: SoulManager;
  cleanup: () => void;
}

function createTestSetup(opts?: { skipInit?: boolean }): TestSetup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-mgr-test-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });

  const manager = new SoulManager({ stateDir });

  if (!opts?.skipInit) {
    const content = generateSoulMd('TestAgent', 'Thorough and direct.', '2026-03-14');
    manager.initialize(content);
  }

  return {
    dir,
    stateDir,
    manager,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('SoulManager', () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestSetup();
  });

  afterEach(() => {
    setup?.cleanup();
  });

  describe('initialization', () => {
    it('creates soul.md and init snapshot', () => {
      expect(fs.existsSync(path.join(setup.stateDir, 'soul.md'))).toBe(true);
      expect(fs.existsSync(path.join(setup.stateDir, 'state', 'soul.init.md'))).toBe(true);
    });

    it('marks soul as enabled after init', () => {
      expect(setup.manager.isEnabled()).toBe(true);
    });

    it('reports not enabled before init', () => {
      const noInitSetup = createTestSetup({ skipInit: true });
      expect(noInitSetup.manager.isEnabled()).toBe(false);
      noInitSetup.cleanup();
    });

    it('soul.md and init snapshot have identical content', () => {
      const soul = fs.readFileSync(path.join(setup.stateDir, 'soul.md'), 'utf-8');
      const init = fs.readFileSync(path.join(setup.stateDir, 'state', 'soul.init.md'), 'utf-8');
      expect(soul).toBe(init);
    });

    it('stores integrity hash on init', () => {
      const integrityPath = path.join(setup.stateDir, 'state', 'soul-integrity.json');
      expect(fs.existsSync(integrityPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(integrityPath, 'utf-8'));
      expect(data.hash).toBeTruthy();
      expect(typeof data.hash).toBe('string');
      expect(data.hash.length).toBe(64); // SHA-256 hex
    });
  });

  describe('readSoul', () => {
    it('returns full soul.md content', () => {
      const content = setup.manager.readSoul();
      expect(content).toContain('# Soul');
      expect(content).toContain('Thorough and direct.');
      expect(content).toContain('## Core Values');
    });

    it('returns null when not enabled', () => {
      const noInitSetup = createTestSetup({ skipInit: true });
      expect(noInitSetup.manager.readSoul()).toBeNull();
      noInitSetup.cleanup();
    });
  });

  describe('readPublicSections', () => {
    it('returns Personality Seed and Core Values only', () => {
      const publicContent = setup.manager.readPublicSections();
      expect(publicContent).toContain('Personality Seed');
      expect(publicContent).toContain('Core Values');
      expect(publicContent).not.toContain('Convictions');
      expect(publicContent).not.toContain('Open Questions');
    });
  });

  describe('trust enforcement', () => {
    it('allows autonomous to write any section', () => {
      expect(setup.manager.checkSectionAccess('core-values', 'autonomous')).toBe(true);
      expect(setup.manager.checkSectionAccess('convictions', 'autonomous')).toBe(true);
      expect(setup.manager.checkSectionAccess('integrations', 'autonomous')).toBe(true);
    });

    it('allows collaborative to write any section', () => {
      expect(setup.manager.checkSectionAccess('core-values', 'collaborative')).toBe(true);
      expect(setup.manager.checkSectionAccess('growth-edge', 'collaborative')).toBe(true);
    });

    it('allows cautious to write integrations and evolution-history only', () => {
      expect(setup.manager.checkSectionAccess('integrations', 'cautious')).toBe(true);
      expect(setup.manager.checkSectionAccess('evolution-history', 'cautious')).toBe(true);
      expect(setup.manager.checkSectionAccess('core-values', 'cautious')).toBe(false);
      expect(setup.manager.checkSectionAccess('convictions', 'cautious')).toBe(false);
      expect(setup.manager.checkSectionAccess('growth-edge', 'cautious')).toBe(false);
    });

    it('blocks cautious from writing core-values with trust_violation error', () => {
      expect(() => {
        setup.manager.patch(
          { section: 'core-values', operation: 'replace', content: 'New values', source: 'inline' },
          'cautious',
        );
      }).toThrow(SoulError);

      try {
        setup.manager.patch(
          { section: 'core-values', operation: 'replace', content: 'New values', source: 'inline' },
          'cautious',
        );
      } catch (err) {
        expect((err as SoulError).code).toBe('trust_violation');
      }
    });

    it('queues supervised core-values writes as pending', () => {
      const result = setup.manager.patch(
        { section: 'core-values', operation: 'replace', content: 'Honesty above all.', source: 'inline' },
        'supervised',
      );

      expect(result.status).toBe('pending');
      expect(result.pendingId).toBeTruthy();
      expect(result.pendingId).toMatch(/^PND-\d{3}$/);
    });

    it('allows autonomous to write core-values directly', () => {
      const result = setup.manager.patch(
        { section: 'core-values', operation: 'replace', content: 'Build things that matter.', source: 'inline' },
        'autonomous',
      );

      expect(result.status).toBe('applied');

      const content = setup.manager.readSoul()!;
      expect(content).toContain('Build things that matter.');
    });

    it('allows cautious to append to integrations', () => {
      const result = setup.manager.patch(
        { section: 'integrations', operation: 'append', content: '### 2026-03-14: First realization\nLearned something.', source: 'inline' },
        'cautious',
      );

      expect(result.status).toBe('applied');
      const content = setup.manager.readSoul()!;
      expect(content).toContain('First realization');
    });
  });

  describe('pending queue', () => {
    it('adds changes to pending queue', () => {
      setup.manager.patch(
        { section: 'convictions', operation: 'append', content: '| Test | growing | 2026-03-14 | experience |', source: 'reflect-skill' },
        'supervised',
      );

      const pending = setup.manager.getPending('pending');
      expect(pending).toHaveLength(1);
      expect(pending[0].section).toBe('convictions');
      expect(pending[0].status).toBe('pending');
    });

    it('approves pending change and applies to soul.md', () => {
      const result = setup.manager.patch(
        { section: 'core-values', operation: 'append', content: '1. **Build with care.**', source: 'reflect-skill' },
        'supervised',
      );

      expect(result.status).toBe('pending');
      const pendingId = result.pendingId!;

      // Approve
      const approveResult = setup.manager.approvePending(pendingId);
      expect(approveResult.status).toBe('applied');

      // Verify applied
      const content = setup.manager.readSoul()!;
      expect(content).toContain('Build with care.');

      // Pending should be marked approved
      const allPending = setup.manager.getPending();
      const approved = allPending.find(p => p.id === pendingId);
      expect(approved?.status).toBe('approved');
    });

    it('rejects pending change with reason', () => {
      const result = setup.manager.patch(
        { section: 'growth-edge', operation: 'replace', content: 'World domination.', source: 'inline' },
        'supervised',
      );

      setup.manager.rejectPending(result.pendingId!, 'Not aligned with user intent');

      const rejected = setup.manager.getPending().find(p => p.id === result.pendingId);
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.rejectionReason).toBe('Not aligned with user intent');
    });

    it('throws when approving non-existent pending', () => {
      expect(() => {
        setup.manager.approvePending('PND-999');
      }).toThrow();
    });

    it('throws when approving already-approved pending', () => {
      const result = setup.manager.patch(
        { section: 'core-values', operation: 'append', content: 'Test value.', source: 'inline' },
        'supervised',
      );
      setup.manager.approvePending(result.pendingId!);

      expect(() => {
        setup.manager.approvePending(result.pendingId!);
      }).toThrow();
    });
  });

  describe('section operations', () => {
    it('replaces section content', () => {
      setup.manager.patch(
        { section: 'growth-edge', operation: 'replace', content: 'Learning to build things that last.', source: 'reflect-skill' },
        'autonomous',
      );

      const content = setup.manager.readSoul()!;
      expect(content).toContain('Learning to build things that last.');
    });

    it('appends to section', () => {
      setup.manager.patch(
        { section: 'integrations', operation: 'append', content: '### 2026-03-14: Discovery\nSomething important.', source: 'inline' },
        'autonomous',
      );

      const content = setup.manager.readSoul()!;
      expect(content).toContain('### 2026-03-14: Discovery');
    });

    it('removes from section', () => {
      // First add something
      setup.manager.patch(
        { section: 'integrations', operation: 'append', content: 'REMOVE_ME_PLEASE', source: 'inline' },
        'autonomous',
      );

      // Then remove it
      setup.manager.patch(
        { section: 'integrations', operation: 'remove', content: 'REMOVE_ME_PLEASE', source: 'inline' },
        'autonomous',
      );

      const content = setup.manager.readSoul()!;
      expect(content).not.toContain('REMOVE_ME_PLEASE');
    });
  });

  describe('drift detection', () => {
    it('reports no drift when unchanged', () => {
      const drift = setup.manager.analyzeDrift();
      expect(drift.anyAboveThreshold).toBe(false);
      expect(drift.initSnapshotExists).toBe(true);
    });

    it('detects drift in core-values after modification', () => {
      setup.manager.patch(
        {
          section: 'core-values',
          operation: 'replace',
          content: '1. **Completely new value one.**\n2. **Completely new value two.**\n3. **And another one.**',
          source: 'inline',
        },
        'autonomous',
      );

      const drift = setup.manager.analyzeDrift();
      const coreValuesDrift = drift.sections.find(s => s.section === 'core-values');
      expect(coreValuesDrift).toBeTruthy();
      expect(coreValuesDrift!.divergencePercent).toBeGreaterThan(0);
    });

    it('reports no drift without init snapshot', () => {
      // Delete the init snapshot
      // safe-git-allow: incremental-migration
      fs.unlinkSync(path.join(setup.stateDir, 'state', 'soul.init.md'));

      const drift = setup.manager.analyzeDrift();
      expect(drift.initSnapshotExists).toBe(false);
      expect(drift.sections).toHaveLength(0);
    });

    it('marks drift as reviewed', () => {
      setup.manager.markDriftReviewed();
      const drift = setup.manager.analyzeDrift();
      expect(drift.lastReviewedAt).toBeTruthy();
    });
  });

  describe('integrity verification', () => {
    it('passes integrity check after init', () => {
      const result = setup.manager.verifyIntegrity();
      expect(result.valid).toBe(true);
    });

    it('passes integrity check after patch', () => {
      setup.manager.patch(
        { section: 'integrations', operation: 'append', content: 'New integration.', source: 'inline' },
        'autonomous',
      );

      const result = setup.manager.verifyIntegrity();
      expect(result.valid).toBe(true);
    });

    it('fails integrity check after external modification', () => {
      // Modify soul.md directly (simulating external tampering)
      const soulPath = path.join(setup.stateDir, 'soul.md');
      fs.appendFileSync(soulPath, '\n\nINJECTED CONTENT');

      const result = setup.manager.verifyIntegrity();
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('hash mismatch');
    });
  });

  describe('compaction content', () => {
    it('returns public sections when integrity is valid', () => {
      const content = setup.manager.getCompactionContent();
      expect(content).toBeTruthy();
      expect(content).toContain('Personality Seed');
      expect(content).toContain('Core Values');
    });

    it('falls back to init snapshot when integrity fails', () => {
      // Tamper with soul.md
      const soulPath = path.join(setup.stateDir, 'soul.md');
      fs.appendFileSync(soulPath, '\n\nTAMPERED');

      const content = setup.manager.getCompactionContent();
      // Should fall back to init snapshot's Personality Seed
      expect(content).toContain('Personality Seed');
      expect(content).not.toContain('TAMPERED');
    });

    it('returns null when not enabled', () => {
      const noInitSetup = createTestSetup({ skipInit: true });
      expect(noInitSetup.manager.getCompactionContent()).toBeNull();
      noInitSetup.cleanup();
    });
  });

  describe('audit trail', () => {
    it('emits audit events on write', () => {
      setup.manager.patch(
        { section: 'integrations', operation: 'append', content: 'Test entry.', source: 'reflect-skill' },
        'autonomous',
      );

      const ledger = fs.readFileSync(path.join(setup.stateDir, 'security.jsonl'), 'utf-8');
      const events = ledger.trim().split('\n').map(line => JSON.parse(line));
      const soulEvents = events.filter((e: { event: string }) => e.event === 'soul.write');

      expect(soulEvents.length).toBeGreaterThan(0);
      expect(soulEvents[0].section).toBe('integrations');
      expect(soulEvents[0].operation).toBe('append');
      expect(soulEvents[0].source).toBe('reflect-skill');
      expect(soulEvents[0].trustLevel).toBe('autonomous');
    });

    it('emits audit event on rejection', () => {
      const result = setup.manager.patch(
        { section: 'core-values', operation: 'replace', content: 'Bad values.', source: 'threadline' },
        'supervised',
      );

      setup.manager.rejectPending(result.pendingId!, 'Not appropriate');

      const ledger = fs.readFileSync(path.join(setup.stateDir, 'security.jsonl'), 'utf-8');
      const events = ledger.trim().split('\n').map(line => JSON.parse(line));
      const rejectEvent = events.find((e: { diffSummary: string }) =>
        e.diffSummary.includes('Rejected'),
      );
      expect(rejectEvent).toBeTruthy();
    });
  });
});
