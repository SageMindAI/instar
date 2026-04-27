import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserManager } from '../../src/users/UserManager.js';
import type { UserProfile, Message } from '../../src/core/types.js';

describe('UserManager', () => {
  let tmpDir: string;
  let manager: UserManager;

  const justin: UserProfile = {
    id: 'justin',
    name: 'Justin',
    channels: [
      { type: 'telegram', identifier: 'topic_42' },
      { type: 'email', identifier: 'justin@example.com' },
    ],
    permissions: ['admin', 'deploy'],
    preferences: {
      style: 'technical, direct, autonomous',
      autonomyLevel: 'full',
      timezone: 'America/New_York',
    },
  };

  const adriana: UserProfile = {
    id: 'adriana',
    name: 'Adriana',
    channels: [
      { type: 'telegram', identifier: 'topic_43' },
      { type: 'email', identifier: 'adriana@example.com' },
    ],
    permissions: ['request', 'review'],
    preferences: {
      style: 'prefers context, asks questions',
      autonomyLevel: 'confirm-destructive',
      timezone: 'America/New_York',
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-user-test-'));
    manager = new UserManager(tmpDir, [justin, adriana]);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveFromMessage', () => {
    it('resolves Justin from Telegram message', () => {
      const message: Message = {
        id: 'msg-1',
        userId: '',
        content: 'Deploy the latest',
        channel: { type: 'telegram', identifier: 'topic_42' },
        receivedAt: new Date().toISOString(),
      };

      const user = manager.resolveFromMessage(message);
      expect(user?.id).toBe('justin');
      expect(user?.name).toBe('Justin');
    });

    it('resolves Adriana from email', () => {
      const user = manager.resolveFromChannel({
        type: 'email',
        identifier: 'adriana@example.com',
      });
      expect(user?.id).toBe('adriana');
    });

    it('returns null for unknown channel', () => {
      const user = manager.resolveFromChannel({
        type: 'telegram',
        identifier: 'unknown_topic',
      });
      expect(user).toBeNull();
    });
  });

  describe('permissions', () => {
    it('checks direct permission', () => {
      expect(manager.hasPermission('justin', 'deploy')).toBe(true);
      expect(manager.hasPermission('adriana', 'deploy')).toBe(false);
    });

    it('admin permission grants everything', () => {
      expect(manager.hasPermission('justin', 'anything')).toBe(true);
    });

    it('returns false for unknown user', () => {
      expect(manager.hasPermission('nobody', 'deploy')).toBe(false);
    });
  });

  describe('CRUD operations', () => {
    it('lists all users', () => {
      const users = manager.listUsers();
      expect(users).toHaveLength(2);
      expect(users.map(u => u.id).sort()).toEqual(['adriana', 'justin']);
    });

    it('gets user by ID', () => {
      const user = manager.getUser('justin');
      expect(user?.name).toBe('Justin');
    });

    it('upserts existing user', () => {
      const updated = { ...justin, preferences: { ...justin.preferences, style: 'updated' } };
      manager.upsertUser(updated);

      const user = manager.getUser('justin');
      expect(user?.preferences.style).toBe('updated');
    });

    it('removes a user', () => {
      expect(manager.removeUser('adriana')).toBe(true);
      expect(manager.getUser('adriana')).toBeNull();
      expect(manager.listUsers()).toHaveLength(1);
    });

    it('persists users to disk', () => {
      // Create a new manager from the same directory — should load persisted data
      const newManager = new UserManager(tmpDir);
      expect(newManager.listUsers()).toHaveLength(2);
      expect(newManager.getUser('justin')?.name).toBe('Justin');
    });
  });
});
