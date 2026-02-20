/**
 * Tests for StateManager atomic write operations.
 *
 * Verifies: atomic writes don't leave .tmp files on success,
 * data integrity after write, key validation on all methods.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateManager } from '../../src/core/StateManager.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';

describe('StateManager atomic writes', () => {
  let project: TempProject;
  let state: StateManager;

  beforeEach(() => {
    project = createTempProject();
    state = new StateManager(project.stateDir);
    // Ensure directories exist
    fs.mkdirSync(path.join(project.stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(project.stateDir, 'state', 'jobs'), { recursive: true });
  });

  afterEach(() => {
    project.cleanup();
  });

  describe('saveSession (atomic)', () => {
    it('saves session data correctly', () => {
      const session = {
        id: 'test-123',
        name: 'test-session',
        status: 'running' as const,
        tmuxSession: 'proj-test',
        startedAt: new Date().toISOString(),
      };
      state.saveSession(session);

      const loaded = state.getSession('test-123');
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('test-session');
    });

    it('does not leave .tmp files after successful write', () => {
      const session = {
        id: 'clean-write',
        name: 'clean',
        status: 'running' as const,
        tmuxSession: 'proj-clean',
        startedAt: new Date().toISOString(),
      };
      state.saveSession(session);

      const sessDir = path.join(project.stateDir, 'state', 'sessions');
      const tmpFiles = fs.readdirSync(sessDir).filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('overwrites existing session atomically', () => {
      const session = {
        id: 'overwrite-test',
        name: 'original',
        status: 'running' as const,
        tmuxSession: 'proj-test',
        startedAt: new Date().toISOString(),
      };
      state.saveSession(session);

      session.status = 'completed';
      session.name = 'updated';
      state.saveSession(session);

      const loaded = state.getSession('overwrite-test');
      expect(loaded!.status).toBe('completed');
      expect(loaded!.name).toBe('updated');
    });
  });

  describe('saveJobState (atomic)', () => {
    it('saves job state correctly', () => {
      state.saveJobState({
        slug: 'test-job',
        lastRun: new Date().toISOString(),
        runCount: 5,
        lastStatus: 'success',
      });

      const loaded = state.getJobState('test-job');
      expect(loaded).not.toBeNull();
      expect(loaded!.runCount).toBe(5);
    });

    it('does not leave .tmp files', () => {
      state.saveJobState({
        slug: 'clean-job',
        lastRun: new Date().toISOString(),
        runCount: 1,
        lastStatus: 'success',
      });

      const jobDir = path.join(project.stateDir, 'state', 'jobs');
      const tmpFiles = fs.readdirSync(jobDir).filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('generic set (atomic)', () => {
    it('saves and retrieves values', () => {
      state.set('my-data', { foo: 'bar', count: 42 });
      const loaded = state.get<{ foo: string; count: number }>('my-data');
      expect(loaded).toEqual({ foo: 'bar', count: 42 });
    });

    it('does not leave .tmp files', () => {
      state.set('clean-generic', { value: true });
      const stateDir = path.join(project.stateDir, 'state');
      const tmpFiles = fs.readdirSync(stateDir).filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('key validation', () => {
    it('rejects path traversal in session ID', () => {
      expect(() => state.getSession('../../etc/passwd')).toThrow('Invalid sessionId');
    });

    it('rejects path traversal in job slug', () => {
      expect(() => state.getJobState('../../../evil')).toThrow('Invalid job slug');
    });

    it('rejects path traversal in generic key', () => {
      expect(() => state.get('../../hack')).toThrow('Invalid state key');
    });

    it('allows valid keys', () => {
      expect(() => state.get('valid-key_123')).not.toThrow();
    });
  });
});
