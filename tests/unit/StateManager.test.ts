import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session, ActivityEvent } from '../../src/core/types.js';

describe('StateManager', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-test-'));
    // Create required subdirectories
    fs.mkdirSync(path.join(tmpDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    state = new StateManager(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Session State', () => {
    const makeSession = (overrides?: Partial<Session>): Session => ({
      id: 'test-123',
      name: 'test-session',
      status: 'running',
      tmuxSession: 'project-test-session',
      startedAt: new Date().toISOString(),
      ...overrides,
    });

    it('saves and retrieves a session', () => {
      const session = makeSession();
      state.saveSession(session);

      const retrieved = state.getSession('test-123');
      expect(retrieved).toEqual(session);
    });

    it('returns null for unknown session', () => {
      expect(state.getSession('nonexistent')).toBeNull();
    });

    it('lists sessions by status', () => {
      state.saveSession(makeSession({ id: 'a', status: 'running' }));
      state.saveSession(makeSession({ id: 'b', status: 'completed' }));
      state.saveSession(makeSession({ id: 'c', status: 'running' }));

      const running = state.listSessions({ status: 'running' });
      expect(running).toHaveLength(2);
      expect(running.map(s => s.id).sort()).toEqual(['a', 'c']);
    });

    it('lists all sessions without filter', () => {
      state.saveSession(makeSession({ id: 'a', status: 'running' }));
      state.saveSession(makeSession({ id: 'b', status: 'completed' }));

      const all = state.listSessions();
      expect(all).toHaveLength(2);
    });
  });

  describe('Job State', () => {
    it('saves and retrieves job state', () => {
      const jobState = {
        slug: 'email-check',
        lastRun: new Date().toISOString(),
        lastResult: 'success' as const,
        consecutiveFailures: 0,
      };

      state.saveJobState(jobState);
      const retrieved = state.getJobState('email-check');
      expect(retrieved).toEqual(jobState);
    });

    it('returns null for unknown job', () => {
      expect(state.getJobState('nonexistent')).toBeNull();
    });
  });

  describe('Activity Events', () => {
    it('appends and queries events', () => {
      const event: ActivityEvent = {
        type: 'session_start',
        summary: 'Started email check job',
        sessionId: 'test-123',
        timestamp: new Date().toISOString(),
      };

      state.appendEvent(event);
      state.appendEvent({ ...event, type: 'session_end', summary: 'Finished' });

      const events = state.queryEvents({});
      expect(events).toHaveLength(2);
    });

    it('filters events by type', () => {
      state.appendEvent({
        type: 'session_start',
        summary: 'Start',
        timestamp: new Date().toISOString(),
      });
      state.appendEvent({
        type: 'job_complete',
        summary: 'Done',
        timestamp: new Date().toISOString(),
      });

      const starts = state.queryEvents({ type: 'session_start' });
      expect(starts).toHaveLength(1);
      expect(starts[0].type).toBe('session_start');
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        state.appendEvent({
          type: 'test',
          summary: `Event ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      const events = state.queryEvents({ limit: 3 });
      expect(events).toHaveLength(3);
    });
  });

  describe('Generic Key-Value', () => {
    it('stores and retrieves values', () => {
      state.set('test-key', { foo: 'bar', count: 42 });
      const value = state.get<{ foo: string; count: number }>('test-key');
      expect(value).toEqual({ foo: 'bar', count: 42 });
    });

    it('returns null for missing keys', () => {
      expect(state.get('missing')).toBeNull();
    });

    it('overwrites existing values', () => {
      state.set('overwrite-test', { version: 1 });
      state.set('overwrite-test', { version: 2 });
      const value = state.get<{ version: number }>('overwrite-test');
      expect(value).toEqual({ version: 2 });
    });
  });

  describe('Path Traversal Prevention', () => {
    it('rejects session IDs with path traversal characters', () => {
      expect(() => state.getSession('../etc/passwd')).toThrow('Invalid sessionId');
      expect(() => state.getSession('../../root')).toThrow('Invalid sessionId');
    });

    it('rejects session IDs with dots', () => {
      expect(() => state.getSession('test.session')).toThrow('Invalid sessionId');
    });

    it('rejects session IDs with slashes', () => {
      expect(() => state.getSession('test/session')).toThrow('Invalid sessionId');
    });

    it('rejects job slugs with path traversal', () => {
      expect(() => state.getJobState('../etc/passwd')).toThrow('Invalid job slug');
    });

    it('rejects state keys with special characters', () => {
      expect(() => state.get('../../../etc/shadow')).toThrow('Invalid state key');
    });

    it('allows valid session IDs with hyphens and underscores', () => {
      // Should not throw
      expect(state.getSession('valid-session_123')).toBeNull();
    });

    it('allows valid job slugs', () => {
      expect(state.getJobState('health-check')).toBeNull();
      expect(state.getJobState('email_monitor')).toBeNull();
    });
  });

  describe('Corrupted File Handling', () => {
    it('returns null for corrupted session files', () => {
      const filePath = path.join(tmpDir, 'state', 'sessions', 'corrupt.json');
      fs.writeFileSync(filePath, 'not valid json{{{');
      expect(state.getSession('corrupt')).toBeNull();
    });

    it('returns null for corrupted job state files', () => {
      const filePath = path.join(tmpDir, 'state', 'jobs', 'broken.json');
      fs.writeFileSync(filePath, '{invalid');
      expect(state.getJobState('broken')).toBeNull();
    });

    it('skips corrupted files when listing sessions', () => {
      // Write one valid and one corrupt session
      const valid: Session = {
        id: 'valid-1',
        name: 'valid',
        status: 'running',
        tmuxSession: 'test-valid',
        startedAt: new Date().toISOString(),
      };
      state.saveSession(valid);

      const corruptPath = path.join(tmpDir, 'state', 'sessions', 'corrupt.json');
      fs.writeFileSync(corruptPath, 'broken json!!!');

      const sessions = state.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('valid-1');
    });

    it('returns null for corrupted generic state files', () => {
      const filePath = path.join(tmpDir, 'state', 'bad-data.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, ']]not json[[');
      expect(state.get('bad-data')).toBeNull();
    });

    it('discriminates permission errors from corruption (EPERM/EACCES)', () => {
      // Permission errors should not be labeled "Corrupted" — they're an
      // operator-actionable Full Disk Access issue on macOS, not a corrupt file.
      // We capture the DegradationReporter's reason via console.warn ordering:
      // permission errors emit "permission" kind, parse errors emit "parse".
      const filePath = path.join(tmpDir, 'state', 'jobs', 'unreadable.json');
      fs.writeFileSync(filePath, '{"slug":"unreadable","lastRunAt":null,"runCount":0}');
      // Make file unreadable (skip when running as root, where chmod is bypassed).
      if (process.getuid && process.getuid() === 0) return;
      fs.chmodSync(filePath, 0o000);
      try {
        const warnings: string[] = [];
        const origWarn = console.warn;
        console.warn = (msg: unknown) => warnings.push(String(msg));
        try {
          expect(state.getJobState('unreadable')).toBeNull();
        } finally {
          console.warn = origWarn;
        }
        // Either the read raises EACCES (permission kind) — happy path for the
        // discrimination — or in some sandboxed test runners chmod 0o000 is a
        // no-op and the file is still readable, in which case getJobState
        // returns the parsed value. Both outcomes are acceptable here; what
        // we're guarding against is the OLD behavior of labeling a permission
        // error as "Corrupted job state file".
        const permissionMsgs = warnings.filter((w) => w.includes('permission'));
        const corruptionMsgs = warnings.filter((w) => /\bparse\b|\bCorrupted\b/.test(w));
        if (warnings.length > 0) {
          expect(permissionMsgs.length).toBeGreaterThan(0);
          expect(corruptionMsgs.length).toBe(0);
        }
      } finally {
        fs.chmodSync(filePath, 0o644);
      }
    });
  });

  describe('Empty Directory Handling', () => {
    it('returns empty list when sessions dir does not exist', () => {
      // Remove the sessions directory
      // safe-git-allow: incremental-migration
      fs.rmSync(path.join(tmpDir, 'state', 'sessions'), { recursive: true, force: true });
      expect(state.listSessions()).toEqual([]);
    });

    it('returns empty events when logs dir does not exist', () => {
      // safe-git-allow: incremental-migration
      fs.rmSync(path.join(tmpDir, 'logs'), { recursive: true, force: true });
      expect(state.queryEvents({})).toEqual([]);
    });
  });
});
