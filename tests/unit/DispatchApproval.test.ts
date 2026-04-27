/**
 * Unit tests for DispatchManager approval gate.
 *
 * Tests cover:
 * - markPendingApproval(): sets the flag correctly
 * - approve(): clears flag, marks applied, records evaluation
 * - reject(): clears flag, records rejection evaluation
 * - pendingApproval(): returns only pending-approval dispatches
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DispatchManager } from '../../src/core/DispatchManager.js';
import type { Dispatch } from '../../src/core/DispatchManager.js';

describe('DispatchManager approval gate', () => {
  let tmpDir: string;
  let dispatchFile: string;
  let manager: DispatchManager;

  function seedDispatches(items: Partial<Dispatch>[]) {
    const full = items.map((item, i) => ({
      dispatchId: item.dispatchId || `d-${i}`,
      type: item.type || 'lesson',
      title: item.title || `Dispatch ${i}`,
      content: item.content || `Content for dispatch ${i}`,
      priority: item.priority || 'normal',
      createdAt: item.createdAt || '2026-02-25T10:00:00.000Z',
      receivedAt: item.receivedAt || '2026-02-25T10:00:01.000Z',
      applied: item.applied ?? false,
      pendingApproval: item.pendingApproval ?? false,
      evaluation: item.evaluation,
      feedback: item.feedback,
    }));
    fs.writeFileSync(dispatchFile, JSON.stringify(full, null, 2));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-approval-test-'));
    const stateDir = path.join(tmpDir, '.instar', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    dispatchFile = path.join(stateDir, 'dispatches.json');

    manager = new DispatchManager({
      enabled: true,
      dispatchUrl: '',
      dispatchFile,
      autoApply: false,
    });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('markPendingApproval()', () => {
    it('sets pendingApproval flag on a dispatch', () => {
      seedDispatches([
        { dispatchId: 'sec-1', type: 'security', title: 'Security update' },
      ]);

      const result = manager.markPendingApproval('sec-1');
      expect(result).toBe(true);

      const dispatch = manager.get('sec-1');
      expect(dispatch?.pendingApproval).toBe(true);
    });

    it('returns false for non-existent dispatch', () => {
      seedDispatches([]);
      expect(manager.markPendingApproval('nonexistent')).toBe(false);
    });
  });

  describe('approve()', () => {
    it('clears pendingApproval and marks applied', () => {
      seedDispatches([
        { dispatchId: 'sec-2', type: 'security', pendingApproval: true },
      ]);

      const result = manager.approve('sec-2');
      expect(result).toBe(true);

      const dispatch = manager.get('sec-2');
      expect(dispatch?.pendingApproval).toBe(false);
      expect(dispatch?.applied).toBe(true);
      expect(dispatch?.evaluation?.decision).toBe('accepted');
      expect(dispatch?.evaluation?.reason).toContain('approved');
    });

    it('returns false for non-existent dispatch', () => {
      seedDispatches([]);
      expect(manager.approve('nonexistent')).toBe(false);
    });
  });

  describe('reject()', () => {
    it('clears pendingApproval and records rejection', () => {
      seedDispatches([
        { dispatchId: 'sec-3', type: 'security', pendingApproval: true },
      ]);

      const result = manager.reject('sec-3', 'Not applicable to our setup');
      expect(result).toBe(true);

      const dispatch = manager.get('sec-3');
      expect(dispatch?.pendingApproval).toBe(false);
      expect(dispatch?.applied).toBe(false);
      expect(dispatch?.evaluation?.decision).toBe('rejected');
      expect(dispatch?.evaluation?.reason).toBe('Not applicable to our setup');
    });

    it('returns false for non-existent dispatch', () => {
      seedDispatches([]);
      expect(manager.reject('nonexistent', 'reason')).toBe(false);
    });
  });

  describe('pendingApproval()', () => {
    it('returns only dispatches with pendingApproval=true', () => {
      seedDispatches([
        { dispatchId: 'd-1', type: 'lesson', applied: true },
        { dispatchId: 'd-2', type: 'security', pendingApproval: true },
        { dispatchId: 'd-3', type: 'behavioral', pendingApproval: true },
        { dispatchId: 'd-4', type: 'strategy', applied: false },
      ]);

      const pending = manager.pendingApproval();
      expect(pending).toHaveLength(2);
      expect(pending.map(d => d.dispatchId).sort()).toEqual(['d-2', 'd-3']);
    });

    it('returns empty array when no dispatches need approval', () => {
      seedDispatches([
        { dispatchId: 'd-1', type: 'lesson', applied: true },
      ]);

      const pending = manager.pendingApproval();
      expect(pending).toHaveLength(0);
    });
  });

  describe('pending() still includes pendingApproval dispatches', () => {
    it('returns both unapplied and pending-approval dispatches', () => {
      seedDispatches([
        { dispatchId: 'd-1', applied: true },
        { dispatchId: 'd-2', applied: false, pendingApproval: false },
        { dispatchId: 'd-3', applied: false, pendingApproval: true },
      ]);

      const pending = manager.pending();
      expect(pending).toHaveLength(2);
      expect(pending.map(d => d.dispatchId).sort()).toEqual(['d-2', 'd-3']);
    });
  });
});
