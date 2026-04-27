/**
 * Edge case tests for UserManager.
 *
 * Covers: channel collision prevention, corrupted file backup creation,
 * malformed entries in persisted file, profile validation, and atomic writes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UserManager } from '../../src/users/UserManager.js';
import type { UserProfile } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('UserManager — edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-edge-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const alice: UserProfile = {
    id: 'alice',
    name: 'Alice',
    channels: [{ type: 'telegram', identifier: '12345' }],
    permissions: ['admin'],
    preferences: { autonomyLevel: 'full' },
  };

  const bob: UserProfile = {
    id: 'bob',
    name: 'Bob',
    channels: [{ type: 'telegram', identifier: '67890' }],
    permissions: ['read'],
    preferences: {},
  };

  describe('channel collision prevention', () => {
    it('throws when assigning an already-claimed channel to another user', () => {
      const mgr = new UserManager(tmpDir, [alice]);

      const evil: UserProfile = {
        id: 'mallory',
        name: 'Mallory',
        channels: [{ type: 'telegram', identifier: '12345' }], // Same as Alice!
        permissions: [],
        preferences: {},
      };

      expect(() => mgr.upsertUser(evil)).toThrow(/already registered to user alice/);
    });

    it('allows re-assigning a channel to the same user (update)', () => {
      const mgr = new UserManager(tmpDir, [alice]);

      const updated: UserProfile = {
        ...alice,
        name: 'Alice Updated',
      };

      // Should NOT throw — same user, same channel
      mgr.upsertUser(updated);
      expect(mgr.getUser('alice')!.name).toBe('Alice Updated');
    });
  });

  describe('profile validation', () => {
    it('rejects empty user ID', () => {
      const mgr = new UserManager(tmpDir);
      const bad: UserProfile = {
        id: '',
        name: 'Nobody',
        channels: [],
        permissions: [],
        preferences: {},
      };
      expect(() => mgr.upsertUser(bad)).toThrow('non-empty string');
    });

    it('rejects whitespace-only user ID', () => {
      const mgr = new UserManager(tmpDir);
      const bad: UserProfile = {
        id: '   ',
        name: 'Whitespace',
        channels: [],
        permissions: [],
        preferences: {},
      };
      expect(() => mgr.upsertUser(bad)).toThrow('non-empty string');
    });

    it('rejects non-array channels', () => {
      const mgr = new UserManager(tmpDir);
      const bad = {
        id: 'test',
        name: 'Test',
        channels: 'not-an-array',
        permissions: [],
        preferences: {},
      } as unknown as UserProfile;
      expect(() => mgr.upsertUser(bad)).toThrow('channels must be an array');
    });

    it('rejects non-array permissions', () => {
      const mgr = new UserManager(tmpDir);
      const bad = {
        id: 'test',
        name: 'Test',
        channels: [],
        permissions: 'admin',
        preferences: {},
      } as unknown as UserProfile;
      expect(() => mgr.upsertUser(bad)).toThrow('permissions must be an array');
    });
  });

  describe('corrupted file recovery', () => {
    it('backs up corrupted users file', () => {
      const usersFile = path.join(tmpDir, 'users.json');
      fs.writeFileSync(usersFile, 'NOT JSON AT ALL');

      new UserManager(tmpDir);

      // Should have created a .corrupt.{timestamp} backup
      const files = fs.readdirSync(tmpDir);
      const backups = files.filter(f => f.startsWith('users.json.corrupt.'));
      expect(backups.length).toBe(1);

      // Backup should contain the original corrupt content
      const backupContent = fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8');
      expect(backupContent).toBe('NOT JSON AT ALL');
    });

    it('still loads initial users after corruption recovery', () => {
      const usersFile = path.join(tmpDir, 'users.json');
      fs.writeFileSync(usersFile, '{truncated');

      const mgr = new UserManager(tmpDir, [alice]);
      expect(mgr.listUsers()).toHaveLength(1);
      expect(mgr.getUser('alice')!.name).toBe('Alice');
    });
  });

  describe('malformed entries in persisted file', () => {
    it('skips entries without id', () => {
      const usersFile = path.join(tmpDir, 'users.json');
      const data = [
        { name: 'No ID', channels: [], permissions: [], preferences: {} },
        { id: 'valid', name: 'Valid', channels: [], permissions: [], preferences: {} },
      ];
      fs.writeFileSync(usersFile, JSON.stringify(data));

      const mgr = new UserManager(tmpDir);
      expect(mgr.listUsers()).toHaveLength(1);
      expect(mgr.getUser('valid')!.name).toBe('Valid');
    });

    it('skips entries with non-array channels', () => {
      const usersFile = path.join(tmpDir, 'users.json');
      const data = [
        { id: 'bad', name: 'Bad', channels: 'string', permissions: [], preferences: {} },
        { id: 'good', name: 'Good', channels: [], permissions: [], preferences: {} },
      ];
      fs.writeFileSync(usersFile, JSON.stringify(data));

      const mgr = new UserManager(tmpDir);
      expect(mgr.listUsers()).toHaveLength(1);
      expect(mgr.getUser('good')!.name).toBe('Good');
    });

    it('skips channel entries without type or identifier', () => {
      const usersFile = path.join(tmpDir, 'users.json');
      const data = [
        {
          id: 'partial',
          name: 'Partial',
          channels: [
            { type: 'telegram' }, // Missing identifier
            { identifier: '123' }, // Missing type
            { type: 'email', identifier: 'test@test.com' }, // Valid
          ],
          permissions: [],
          preferences: {},
        },
      ];
      fs.writeFileSync(usersFile, JSON.stringify(data));

      const mgr = new UserManager(tmpDir);
      expect(mgr.listUsers()).toHaveLength(1);
      // Only the valid channel should be indexed
      expect(mgr.resolveFromChannel({ type: 'email', identifier: 'test@test.com' })!.id).toBe('partial');
      expect(mgr.resolveFromChannel({ type: 'telegram', identifier: '' })).toBeNull();
    });
  });

  describe('atomic writes', () => {
    it('uses atomic write pattern in source', () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), 'src/users/UserManager.ts'),
        'utf-8',
      );
      // Should use unique temp filename pattern
      expect(source).toContain('.tmp');
      expect(source).toContain('renameSync');
      // Should clean up temp file on failure
      expect(source).toContain('unlinkSync(tmpPath)');
    });

    it('no .tmp files left after persist', () => {
      const mgr = new UserManager(tmpDir, [alice, bob]);
      mgr.upsertUser({
        id: 'charlie',
        name: 'Charlie',
        channels: [{ type: 'slack', identifier: 'U123' }],
        permissions: [],
        preferences: {},
      });

      const files = fs.readdirSync(tmpDir);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('initial user deduplication', () => {
    it('does not overwrite file users with initial users on restart', () => {
      // First run: create with alice
      const mgr1 = new UserManager(tmpDir, [alice]);
      // Update alice's name via upsert
      mgr1.upsertUser({ ...alice, name: 'Alice UPDATED' });

      // Second run with alice in initial users — should NOT overwrite
      const mgr2 = new UserManager(tmpDir, [alice]);
      expect(mgr2.getUser('alice')!.name).toBe('Alice UPDATED');
    });
  });
});
