import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IdentityManager } from '../../../../src/threadline/client/IdentityManager.js';

describe('IdentityManager', () => {
  let tmpDir: string;
  let manager: IdentityManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-id-test-'));
    manager = new IdentityManager(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getOrCreate', () => {
    it('creates a new identity on first call', () => {
      const identity = manager.getOrCreate();
      expect(identity.fingerprint).toHaveLength(32);
      expect(identity.publicKey).toHaveLength(32);
      expect(identity.privateKey).toHaveLength(32);
      expect(identity.createdAt).toBeTruthy();
    });

    it('returns the same identity on subsequent calls', () => {
      const id1 = manager.getOrCreate();
      const id2 = manager.getOrCreate();
      expect(id1.fingerprint).toBe(id2.fingerprint);
      expect(id1.publicKey.equals(id2.publicKey)).toBe(true);
    });

    it('persists identity to disk', () => {
      const id = manager.getOrCreate();
      const keyFile = path.join(tmpDir, 'threadline', 'identity.json');
      expect(fs.existsSync(keyFile)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
      expect(raw.fingerprint).toBe(id.fingerprint);
    });

    it('loads identity from disk on new instance', () => {
      const id1 = manager.getOrCreate();

      // Create new manager pointing to same directory
      const manager2 = new IdentityManager(tmpDir);
      const id2 = manager2.getOrCreate();

      expect(id1.fingerprint).toBe(id2.fingerprint);
      expect(id1.publicKey.equals(id2.publicKey)).toBe(true);
      expect(id1.privateKey.equals(id2.privateKey)).toBe(true);
    });

    it('key file has restricted permissions', () => {
      manager.getOrCreate();
      const keyFile = path.join(tmpDir, 'threadline', 'identity.json');
      const stats = fs.statSync(keyFile);
      // On Unix, mode 0o600 = owner read/write only
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('get', () => {
    it('returns null when no identity exists', () => {
      expect(manager.get()).toBeNull();
    });

    it('returns identity after creation', () => {
      manager.getOrCreate();
      expect(manager.get()).not.toBeNull();
    });

    it('loads from disk when not in memory', () => {
      manager.getOrCreate();
      const manager2 = new IdentityManager(tmpDir);
      expect(manager2.get()).not.toBeNull();
    });
  });

  describe('exists', () => {
    it('returns false initially', () => {
      expect(manager.exists()).toBe(false);
    });

    it('returns true after creation', () => {
      manager.getOrCreate();
      expect(manager.exists()).toBe(true);
    });

    it('returns true when file exists on disk', () => {
      manager.getOrCreate();
      const manager2 = new IdentityManager(tmpDir);
      expect(manager2.exists()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('handles corrupted key file gracefully', () => {
      const keyDir = path.join(tmpDir, 'threadline');
      fs.mkdirSync(keyDir, { recursive: true });
      fs.writeFileSync(path.join(keyDir, 'identity.json'), 'not valid json');

      // Should generate a new identity instead of crashing
      const id = manager.getOrCreate();
      expect(id.fingerprint).toHaveLength(32);
    });
  });
});
