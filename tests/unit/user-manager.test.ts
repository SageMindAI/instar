/**
 * Tests for UserManager — multi-user identity resolution and permissions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UserManager } from '../../src/users/UserManager.js';
import type { UserProfile, UserChannel, Message } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('UserManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const alice: UserProfile = {
    id: 'alice',
    name: 'Alice',
    channels: [
      { type: 'telegram', identifier: '12345' },
      { type: 'email', identifier: 'alice@example.com' },
    ],
    permissions: ['admin'],
    preferences: { autonomyLevel: 'full' },
  };

  const bob: UserProfile = {
    id: 'bob',
    name: 'Bob',
    channels: [{ type: 'telegram', identifier: '67890' }],
    permissions: ['read'],
    preferences: { style: 'casual' },
  };

  describe('initialization', () => {
    it('loads initial users from config', () => {
      const mgr = new UserManager(tmpDir, [alice, bob]);
      expect(mgr.listUsers()).toHaveLength(2);
    });

    it('creates empty manager with no initial users', () => {
      const mgr = new UserManager(tmpDir);
      expect(mgr.listUsers()).toHaveLength(0);
    });
  });

  describe('resolveFromChannel', () => {
    it('resolves user by telegram channel', () => {
      const mgr = new UserManager(tmpDir, [alice]);
      const resolved = mgr.resolveFromChannel({ type: 'telegram', identifier: '12345' });

      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('Alice');
    });

    it('resolves user by email channel', () => {
      const mgr = new UserManager(tmpDir, [alice]);
      const resolved = mgr.resolveFromChannel({ type: 'email', identifier: 'alice@example.com' });

      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('Alice');
    });

    it('returns null for unknown channel', () => {
      const mgr = new UserManager(tmpDir, [alice]);
      expect(mgr.resolveFromChannel({ type: 'slack', identifier: 'U999' })).toBeNull();
    });
  });

  describe('resolveFromMessage', () => {
    it('resolves user from message channel', () => {
      const mgr = new UserManager(tmpDir, [alice]);
      const message: Message = {
        id: 'msg1',
        userId: '',
        content: 'Hello',
        channel: { type: 'telegram', identifier: '12345' },
        receivedAt: new Date().toISOString(),
      };

      const resolved = mgr.resolveFromMessage(message);
      expect(resolved!.name).toBe('Alice');
    });
  });

  describe('upsertUser', () => {
    it('adds a new user', () => {
      const mgr = new UserManager(tmpDir);
      mgr.upsertUser(alice);

      expect(mgr.getUser('alice')).not.toBeNull();
      expect(mgr.getUser('alice')!.name).toBe('Alice');
    });

    it('updates existing user channels', () => {
      const mgr = new UserManager(tmpDir, [alice]);

      const updated: UserProfile = {
        ...alice,
        channels: [
          { type: 'slack', identifier: 'UNEW' },
        ],
      };
      mgr.upsertUser(updated);

      // Old channel should no longer resolve
      expect(mgr.resolveFromChannel({ type: 'telegram', identifier: '12345' })).toBeNull();
      // New channel should resolve
      expect(mgr.resolveFromChannel({ type: 'slack', identifier: 'UNEW' })!.name).toBe('Alice');
    });

    it('persists to disk', () => {
      const mgr = new UserManager(tmpDir);
      mgr.upsertUser(alice);

      const usersFile = path.join(tmpDir, 'users.json');
      expect(fs.existsSync(usersFile)).toBe(true);
    });
  });

  describe('removeUser', () => {
    it('removes user and cleans up channel index', () => {
      const mgr = new UserManager(tmpDir, [alice, bob]);

      const removed = mgr.removeUser('alice');
      expect(removed).toBe(true);
      expect(mgr.getUser('alice')).toBeNull();
      expect(mgr.resolveFromChannel({ type: 'telegram', identifier: '12345' })).toBeNull();

      // Bob still there
      expect(mgr.getUser('bob')).not.toBeNull();
    });

    it('returns false for unknown user', () => {
      const mgr = new UserManager(tmpDir);
      expect(mgr.removeUser('nonexistent')).toBe(false);
    });
  });

  describe('hasPermission', () => {
    it('returns true for matching permission', () => {
      const mgr = new UserManager(tmpDir, [bob]);
      expect(mgr.hasPermission('bob', 'read')).toBe(true);
    });

    it('admin has all permissions', () => {
      const mgr = new UserManager(tmpDir, [alice]);
      expect(mgr.hasPermission('alice', 'anything')).toBe(true);
    });

    it('returns false for missing permission', () => {
      const mgr = new UserManager(tmpDir, [bob]);
      expect(mgr.hasPermission('bob', 'admin')).toBe(false);
    });

    it('returns false for unknown user', () => {
      const mgr = new UserManager(tmpDir);
      expect(mgr.hasPermission('nobody', 'read')).toBe(false);
    });
  });

  describe('corrupted state', () => {
    it('handles corrupted users file gracefully', () => {
      const usersFile = path.join(tmpDir, 'users.json');
      fs.writeFileSync(usersFile, 'not valid json!!!');

      // Should not throw
      const mgr = new UserManager(tmpDir);
      expect(mgr.listUsers()).toHaveLength(0);
    });

    it('loads initial users even when file is corrupted', () => {
      const usersFile = path.join(tmpDir, 'users.json');
      fs.writeFileSync(usersFile, 'corrupted');

      const mgr = new UserManager(tmpDir, [alice]);
      expect(mgr.listUsers()).toHaveLength(1);
      expect(mgr.getUser('alice')!.name).toBe('Alice');
    });
  });

  describe('persistence across restarts', () => {
    it('loads saved users on construction', () => {
      const mgr1 = new UserManager(tmpDir, [alice, bob]);
      expect(mgr1.listUsers()).toHaveLength(2);

      // Create new manager from same dir (no initial users)
      const mgr2 = new UserManager(tmpDir);
      expect(mgr2.listUsers()).toHaveLength(2);
      expect(mgr2.getUser('alice')!.name).toBe('Alice');
    });

    it('rebuilds channel index on load', () => {
      new UserManager(tmpDir, [alice]);

      const mgr2 = new UserManager(tmpDir);
      const resolved = mgr2.resolveFromChannel({ type: 'email', identifier: 'alice@example.com' });
      expect(resolved!.name).toBe('Alice');
    });
  });
});
